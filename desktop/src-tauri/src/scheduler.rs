use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use crate::config::Config;

/// State of a single download job.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct JobState {
    pub id: String,
    pub url: String,
    pub direct_url: Option<String>,
    pub file_name: String,
    pub save_path: String,
    pub status: String,
    pub downloaded: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub eta_secs: u64,
    pub is_playlist: bool,
    pub error: Option<String>,
    /// Optional per-job connection count from the extension payload (`payload.threads`).
    /// `download.rs` builds and reads this field; without it the crate does not compile.
    #[serde(default)]
    pub threads: Option<u32>,
    /// When true, start_engine downloads via yt-dlp merge instead of core_engine.
    #[serde(default)]
    pub merge_via_ytdlp: bool,
}

/// The download scheduler with a FIFO queue and concurrency cap.
/// Each job is an independent engine process; parallelism is controlled only by
/// `max_concurrent` (Settings), not by forcing CDN hosts one-at-a-time.
#[allow(dead_code)]
pub struct Scheduler {
    config: Config,
    /// Live concurrency cap (updated from Settings UI / extension SET_SETTINGS).
    max_concurrent: AtomicU32,
    queue: Mutex<VecDeque<JobState>>,
    /// Active job ids currently running an engine.
    active: Mutex<Vec<String>>,
}

#[allow(dead_code)]
impl Scheduler {
    pub fn new(config: Config) -> Self {
        let max = config.max_concurrent_downloads.max(1);
        Self {
            config,
            max_concurrent: AtomicU32::new(max),
            queue: Mutex::new(VecDeque::new()),
            active: Mutex::new(Vec::new()),
        }
    }

    pub fn max_concurrent(&self) -> u32 {
        self.max_concurrent.load(Ordering::Relaxed).max(1)
    }

    pub fn set_max_concurrent(&self, n: u32) {
        self.max_concurrent
            .store(n.clamp(1, 64), Ordering::Relaxed);
    }

    /// Enqueue a new download job. Returns the job ID.
    pub fn enqueue(&self, job: JobState) {
        let id = job.id.clone();
        let len = {
            let mut queue = self.queue.lock().unwrap();
            queue.push_back(job);
            queue.len()
        };
        log::info!("Enqueued download {} (queue depth: {})", id, len);
    }

    /// Dequeue and mark as active. Returns None if queue is empty or cap reached.
    pub fn dequeue(&self) -> Option<JobState> {
        let mut active = self.active.lock().unwrap();
        if active.len() >= self.max_concurrent() as usize {
            return None;
        }
        let mut queue = self.queue.lock().unwrap();
        let job = queue.pop_front()?;
        log::info!(
            "Dequeued download {} (active {}/{})",
            job.id,
            active.len() + 1,
            self.max_concurrent()
        );
        active.push(job.id.clone());
        Some(job)
    }

    /// Mark a download as completed/removed from active.
    pub fn finish(&self, id: &str) {
        let mut active = self.active.lock().unwrap();
        active.retain(|a| a != id);
    }

    /// Remove a queued job by ID. Returns true if it was in the queue.
    pub fn remove_queued(&self, id: &str) -> bool {
        let mut queue = self.queue.lock().unwrap();
        let len_before = queue.len();
        queue.retain(|j| j.id != id);
        queue.len() < len_before
    }

    /// Get the current queue depth.
    pub fn queue_depth(&self) -> usize {
        self.queue.lock().unwrap().len()
    }

    /// Get active download count.
    pub fn active_count(&self) -> usize {
        self.active.lock().unwrap().len()
    }

    /// Get all jobs (queued + active) for snapshot.
    pub fn all_jobs(&self) -> Vec<JobState> {
        let queue = self.queue.lock().unwrap();
        let _active = self.active.lock().unwrap();
        let out: Vec<JobState> = queue.iter().cloned().collect();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn make_job(id: &str) -> JobState {
        JobState {
            id: id.to_string(),
            url: format!("https://example.com/{}", id),
            direct_url: None,
            file_name: format!("{}.mp4", id),
            save_path: format!("/tmp/{}.mp4", id),
            status: "queued".to_string(),
            downloaded: 0,
            total: 1000,
            speed_bps: 0,
            eta_secs: 0,
            is_playlist: false,
            error: None,
            threads: None,
            merge_via_ytdlp: false,
        }
    }

    fn new_scheduler(max_concurrent: u32) -> Scheduler {
        // Construct Config directly to avoid env var pollution across parallel tests
        Scheduler::new(Config {
            max_concurrent_downloads: max_concurrent,
            port: 14921,
            default_threads: 8,
            max_rate_bytes: 0,
            min_free_disk_mb: 500,
            engine_quiet: true,
            engine_auto_tune: true,
            engine_read_buffer_bytes: 262144,
            base_dir: None,
            allowed_extension_ids: vec![],
            block_private_hosts: false,
            db_path: None,
        })
    }

    #[test]
    fn test_enqueue_dequeue() {
        let sched = new_scheduler(10);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));

        let j1 = sched.dequeue().expect("should dequeue job1");
        assert_eq!(j1.id, "job1");

        let j2 = sched.dequeue().expect("should dequeue job2");
        assert_eq!(j2.id, "job2");
    }

    #[test]
    fn test_dequeue_respects_concurrency_cap() {
        let sched = new_scheduler(2);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));
        sched.enqueue(make_job("job3"));

        // First two should dequeue
        assert!(sched.dequeue().is_some());
        assert!(sched.dequeue().is_some());
        // Third should be blocked by cap
        assert!(sched.dequeue().is_none());
    }

    #[test]
    fn test_finish_removes_from_active() {
        let sched = new_scheduler(10);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));

        let _j1 = sched.dequeue();
        let _j2 = sched.dequeue();

        assert_eq!(sched.active_count(), 2);
        sched.finish("job1");
        assert_eq!(sched.active_count(), 1);
    }

    #[test]
    fn test_finish_allows_more_dequeues() {
        let sched = new_scheduler(1);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));

        let _j1 = sched.dequeue();
        // queue blocked at cap=1
        assert!(sched.dequeue().is_none());

        sched.finish("job1");
        // Now job2 should be dequeued
        let j2 = sched.dequeue().expect("should dequeue after finish");
        assert_eq!(j2.id, "job2");
    }

    #[test]
    fn test_remove_queued() {
        let sched = new_scheduler(10);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));

        assert!(sched.remove_queued("job1"));
        assert_eq!(sched.queue_depth(), 1);
        // Second removal should fail
        assert!(!sched.remove_queued("job1"));
    }

    #[test]
    fn test_queue_depth() {
        let sched = new_scheduler(10);
        assert_eq!(sched.queue_depth(), 0);
        sched.enqueue(make_job("job1"));
        assert_eq!(sched.queue_depth(), 1);
        sched.enqueue(make_job("job2"));
        assert_eq!(sched.queue_depth(), 2);
    }

    #[test]
    fn test_active_count() {
        let sched = new_scheduler(10);
        assert_eq!(sched.active_count(), 0);
        sched.enqueue(make_job("job1"));
        sched.dequeue();
        assert_eq!(sched.active_count(), 1);
    }

    #[test]
    fn test_mediafire_respects_concurrent_cap_only() {
        let sched = new_scheduler(2);
        {
            let mut q = sched.queue.lock().unwrap();
            q.push_back(JobState {
                id: "mf1".into(),
                url: "https://www.mediafire.com/file/aaa/a.mp4/file".into(),
                direct_url: None,
                file_name: "a.mp4".into(),
                save_path: "/tmp/a.mp4".into(),
                status: "queued".into(),
                downloaded: 0,
                total: 0,
                speed_bps: 0,
                eta_secs: 0,
                is_playlist: false,
                error: None,
                threads: None,
                merge_via_ytdlp: false,
            });
            q.push_back(JobState {
                id: "mf2".into(),
                url: "https://www.mediafire.com/file/bbb/b.mp4/file".into(),
                direct_url: None,
                file_name: "b.mp4".into(),
                save_path: "/tmp/b.mp4".into(),
                status: "queued".into(),
                downloaded: 0,
                total: 0,
                speed_bps: 0,
                eta_secs: 0,
                is_playlist: false,
                error: None,
                threads: None,
                merge_via_ytdlp: false,
            });
            q.push_back(JobState {
                id: "mf3".into(),
                url: "https://www.mediafire.com/file/ccc/c.mp4/file".into(),
                direct_url: None,
                file_name: "c.mp4".into(),
                save_path: "/tmp/c.mp4".into(),
                status: "queued".into(),
                downloaded: 0,
                total: 0,
                speed_bps: 0,
                eta_secs: 0,
                is_playlist: false,
                error: None,
                threads: None,
                merge_via_ytdlp: false,
            });
        }

        // MediaFire jobs run in parallel up to the Settings concurrent cap.
        let j1 = sched.dequeue().expect("mf1");
        assert_eq!(j1.id, "mf1");
        let j2 = sched.dequeue().expect("mf2");
        assert_eq!(j2.id, "mf2");
        assert!(sched.dequeue().is_none(), "mf3 waits on concurrent cap");
        sched.finish("mf1");
        let j3 = sched.dequeue().expect("mf3 after slot free");
        assert_eq!(j3.id, "mf3");
    }

    #[test]
    fn test_dequeue_empty_returns_none() {
        let sched = new_scheduler(10);
        assert!(sched.dequeue().is_none());
    }

    #[test]
    fn test_all_jobs_returns_queued_only() {
        let sched = new_scheduler(10);
        sched.enqueue(make_job("job1"));
        sched.enqueue(make_job("job2"));
        sched.dequeue(); // job1 becomes active

        let jobs = sched.all_jobs();
        assert_eq!(jobs.len(), 1); // only job2 is still queued
        assert_eq!(jobs[0].id, "job2");
    }
}

