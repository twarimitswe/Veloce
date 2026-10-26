//! Linux io_uring backend for batched positioned writes.
//!
//! **Primary path** — pipe + `IORING_OP_SPLICE`:
//! 1. Pending data is written to the pipe write end (userspace → pipe buffer).
//! 2. `IORING_OP_SPLICE` moves data from the pipe read end to the output
//!    file (pipe → page cache via page-table manipulation — zero-copy).
//!
//! **Fallback** — `IORING_OP_WRITE` — used when the kernel doesn't support
//! `IORING_OP_SPLICE`.  Detection happens once: the first splice failure
//! sets `use_splice = false` and all subsequent flushes use the write path.
//!
//! Both paths batch N writes into a single `submit_and_wait` call (8× syscall
//! reduction).  Uses `IORING_SETUP_SQPOLL` to eliminate submission syscalls.
//!
//! Each worker gets its **own** `IoUringEngine` (no sharing).
//!
//! Returns `None` from `try_new()` if io_uring isn't available at all.

#![cfg(target_os = "linux")]

use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;

use io_uring::{opcode, types, IoUring};

/// Number of pending writes before auto-flush.
const BATCH_SIZE: usize = 8;

/// A pending write — kept alive until `flush()` completes it.
struct PendingWrite {
    offset: u64,
    data: Vec<u8>,
}

/// Per-worker io_uring writer.
///
/// Not `Sync` — each worker owns its instance. `IoUring` is `Send`, so
/// this is `Send` by default.
pub struct IoUringEngine {
    ring: IoUring,
    fd: i32,
    pipe_rd: i32,
    pipe_wr: i32,
    pipe_capacity: usize,
    /// Whether `IORING_OP_SPLICE` is known to work on this kernel.
    /// Set to `false` on the first splice failure.
    use_splice: bool,
    pending: Vec<PendingWrite>,
}

impl Drop for IoUringEngine {
    fn drop(&mut self) {
        let _ = self.flush();
        unsafe {
            let _ = libc::close(self.pipe_rd);
            let _ = libc::close(self.pipe_wr);
        }
    }
}

impl IoUringEngine {
    /// Try to create an io_uring engine backed by `file`.
    ///
    /// Returns `None` if io_uring or pipe creation fails.
    pub fn try_new(file: &File, entries: u32) -> io::Result<Option<Self>> {
        // --- per-worker pipe ---
        let mut pipe_fds = [-1i32; 2];
        if unsafe { libc::pipe(pipe_fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let (pipe_rd, pipe_wr) = (pipe_fds[0], pipe_fds[1]);

        // Bump pipe capacity. Max unprivileged size on Linux is 1048576 (1MB).
        let target_cap = 1048576;
        unsafe { libc::fcntl(pipe_wr, libc::F_SETPIPE_SZ, target_cap as libc::c_int); }
        let pipe_capacity = match unsafe { libc::fcntl(pipe_wr, libc::F_GETPIPE_SZ) } {
            cap if cap > 0 => cap as usize,
            _ => 65536,
        };

        // --- io_uring ---
        let ring = match IoUring::builder().setup_sqpoll(2000).build(entries) {
            Ok(r) => r,
            Err(_) => match IoUring::new(entries) {
                Ok(r) => r,
                Err(_) => {
                    unsafe { libc::close(pipe_rd); libc::close(pipe_wr); }
                    return Ok(None);
                }
            },
        };

        Ok(Some(Self {
            ring,
            fd: file.as_raw_fd(),
            pipe_rd,
            pipe_wr,
            pipe_capacity,
            use_splice: true,
            // `write_at_owned` flushes at `len() >= BATCH_SIZE`, so the vec never
            // exceeds BATCH_SIZE entries. Sizing the backing store to 2× just held
            // an extra ~BATCH_SIZE × read_buffer_bytes of idle capacity per worker
            // (≈ 2 MiB/worker at 64 threads × 256 KiB). One BATCH_SIZE is enough.
            pending: Vec::with_capacity(BATCH_SIZE),
        }))
    }

    // ── public API ──────────────────────────────────────────────────────

    /// Queue a positioned write.  Does **not** block unless the pending
    /// batch is full (auto-flush).  Call `flush()` at the end.
    pub fn write_at(&mut self, offset: u64, data: &[u8]) -> io::Result<()> {
        self.write_at_owned(offset, data.to_vec())
    }

    /// Same as `write_at` but takes ownership — avoids an extra copy when the
    /// caller already holds a `Vec` (e.g. flush of the read buffer).
    pub fn write_at_owned(&mut self, offset: u64, data: Vec<u8>) -> io::Result<()> {
        self.pending.push(PendingWrite { offset, data });
        if self.pending.len() >= BATCH_SIZE {
            self.flush()?;
        }
        Ok(())
    }

    /// Flush all pending writes — either via pipe+splice or IORING_OP_WRITE.
    pub fn flush(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }

        if self.use_splice {
            let max_pw = self.pending.iter().map(|p| p.data.len()).max().unwrap_or(0);
            
            if max_pw <= self.pipe_capacity {
                let total: usize = self.pending.iter().map(|p| p.data.len()).sum();
                let result = if total <= self.pipe_capacity {
                    self.flush_batch_splice()
                } else {
                    self.flush_seq_splice()
                };

                match result {
                    Ok(()) => {
                        self.pending.clear();
                        return Ok(());
                    }
                    Err(_) => {
                        // Splice failed — permanently fall back to WRITE.
                        self.use_splice = false;
                        let _ = self.drain_pipe();
                    }
                }
            } else {
                // If a single chunk exceeds pipe capacity, splice will deadlock.
                // We fallback to standard IORING_OP_WRITE for this batch.
                // We do NOT disable use_splice permanently, as future batches might be smaller.
            }
        }

        // Fallback: IORING_OP_WRITE.
        self.flush_write()?;
        self.pending.clear();
        Ok(())
    }

    /// Number of pending writes.
    #[allow(dead_code)]
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    // ── splice helpers ──────────────────────────────────────────────────

    fn flush_batch_splice(&mut self) -> io::Result<()> {
        self.write_all_to_pipe()?;
        self.push_all_splices()?;
        self.ring.submit_and_wait(self.pending.len())?;
        self.consume_all_cqes()?;
        Ok(())
    }

    fn flush_seq_splice(&mut self) -> io::Result<()> {
        while !self.pending.is_empty() {
            let pw = self.pending.swap_remove(0);
            self.write_one_to_pipe(&pw)?;
            let sqe = make_splice_sqe(self.pipe_rd, self.fd, &pw, 0);
            unsafe {
                self.ring.submission()
                    .push(&sqe)
                    .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "submission queue full"))?;
            }
            self.ring.submit_and_wait(1)?;
            match self.ring.completion().next() {
                Some(cqe) => {
                    let r = cqe.result();
                    if r < 0 {
                        return Err(io::Error::from_raw_os_error(-r));
                    }
                    if r as usize != pw.data.len() {
                        return Err(io::Error::new(io::ErrorKind::WriteZero,
                            format!("short splice: {r} of {} bytes", pw.data.len())));
                    }
                }
                None => return Err(io::Error::new(io::ErrorKind::Other, "completion queue empty")),
            }
        }
        Ok(())
    }

    fn write_all_to_pipe(&self) -> io::Result<()> {
        for pw in &self.pending {
            self.write_one_to_pipe(pw)?;
        }
        Ok(())
    }

    fn write_one_to_pipe(&self, pw: &PendingWrite) -> io::Result<()> {
        let mut off = 0usize;
        while off < pw.data.len() {
            let n = unsafe {
                libc::write(self.pipe_wr,
                    pw.data[off..].as_ptr() as *const libc::c_void,
                    (pw.data.len() - off) as libc::size_t)
            };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::Interrupted { continue; }
                return Err(e);
            }
            off += n as usize;
        }
        Ok(())
    }

    /// Push splice SQEs by index to avoid borrow conflicts.
    fn push_all_splices(&mut self) -> io::Result<()> {
        for i in 0..self.pending.len() {
            let sqe = make_splice_sqe(self.pipe_rd, self.fd, &self.pending[i], i as u64);
            unsafe {
                self.ring.submission()
                    .push(&sqe)
                    .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "submission queue full"))?;
            }
        }
        Ok(())
    }

    /// Consume CQEs by index to avoid borrow conflicts.
    fn consume_all_cqes(&mut self) -> io::Result<()> {
        let mut err = None;
        for i in 0..self.pending.len() {
            let pw = &self.pending[i];
            match self.ring.completion().next() {
                Some(cqe) => {
                    let r = cqe.result();
                    if r < 0 {
                        err = Some(io::Error::from_raw_os_error(-r));
                    } else if r as usize != pw.data.len() {
                        err = Some(io::Error::new(io::ErrorKind::WriteZero,
                            format!("short splice: {r} of {} bytes", pw.data.len())));
                    }
                }
                None => return Err(io::Error::new(io::ErrorKind::Other, "completion queue empty")),
            }
        }
        match err { Some(e) => Err(e), None => Ok(()) }
    }

    // ── pipe drain (clean up after failed splice) ────────────────────────

    fn drain_pipe(&self) -> io::Result<()> {
        let mut buf = [0u8; 65536];
        loop {
            let n = unsafe {
                libc::read(self.pipe_rd, buf.as_mut_ptr() as *mut libc::c_void, buf.len())
            };
            if n <= 0 {
                return if n == 0 { Ok(()) } else {
                    let e = io::Error::last_os_error();
                    if e.kind() == io::ErrorKind::Interrupted { continue; }
                    Err(e)
                };
            }
        }
    }

    // ── IORING_OP_WRITE fallback ────────────────────────────────────────

    fn flush_write(&mut self) -> io::Result<()> {
        for i in 0..self.pending.len() {
            let pw = &self.pending[i];
            let sqe = opcode::Write::new(
                types::Fd(self.fd),
                pw.data.as_ptr(),
                pw.data.len() as u32,
            )
            .offset(pw.offset)
            .build()
            .user_data(i as u64);

            unsafe {
                self.ring.submission()
                    .push(&sqe)
                    .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "submission queue full"))?;
            }
        }

        self.ring.submit_and_wait(self.pending.len())?;

        let mut err = None;
        for i in 0..self.pending.len() {
            let pw = &self.pending[i];
            match self.ring.completion().next() {
                Some(cqe) => {
                    let r = cqe.result();
                    if r < 0 {
                        err = Some(io::Error::from_raw_os_error(-r));
                    } else if r as usize != pw.data.len() {
                        err = Some(io::Error::new(io::ErrorKind::WriteZero,
                            format!("short write: {r} of {} bytes", pw.data.len())));
                    }
                }
                None => return Err(io::Error::new(io::ErrorKind::Other, "completion queue empty")),
            }
        }
        match err { Some(e) => Err(e), None => Ok(()) }
    }
}

// ── standalone SQE builders (avoid borrow conflicts with &self) ──────────

fn make_splice_sqe(pipe_rd: i32, fd: i32, pw: &PendingWrite, id: u64) -> io_uring::squeue::Entry {
    opcode::Splice::new(
        types::Fd(pipe_rd),  // fd_in
        -1i64,                // off_in = NULL (pipe position)
        types::Fd(fd),        // fd_out
        pw.offset as i64,     // off_out
        pw.data.len() as u32, // len
    )
    .flags((libc::SPLICE_F_MOVE | libc::SPLICE_F_MORE) as u32)
    .build()
    .user_data(id)
}
