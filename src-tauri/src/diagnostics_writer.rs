//! Bounded, non-blocking producer; the worker owns all rotating-log file I/O.
use serde_json::{json, Value};
use std::{
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc,
    },
    time::{Duration, Instant},
};

#[derive(Default)]
struct Metrics {
    submitted: AtomicU64,
    written: AtomicU64,
    dropped: AtomicU64,
    pending: AtomicU64,
    io_failures: AtomicU64,
    max_enqueue_us: AtomicU64,
    max_write_us: AtomicU64,
    alive: AtomicBool,
}
enum Message {
    Line(String),
    Fence(SyncSender<()>),
}
#[derive(Clone)]
pub struct Writer {
    sender: SyncSender<Message>,
    metrics: Arc<Metrics>,
}

impl Writer {
    pub fn new(directory: Option<PathBuf>, max_bytes: u64) -> Self {
        Self::with_sink(256, move |line| append(&directory, max_bytes, &line))
    }
    fn with_sink(
        capacity: usize,
        mut sink: impl FnMut(String) -> std::io::Result<()> + Send + 'static,
    ) -> Self {
        let (sender, receiver) = mpsc::sync_channel(capacity);
        let metrics = Arc::new(Metrics::default());
        metrics.alive.store(true, Ordering::Relaxed);
        let worker_metrics = metrics.clone();
        let spawned = std::thread::Builder::new()
            .name("simeioma-diagnostic-writer".into())
            .spawn(move || {
                struct Alive(Arc<Metrics>);
                impl Drop for Alive {
                    fn drop(&mut self) {
                        self.0.alive.store(false, Ordering::Relaxed);
                    }
                }
                let _alive = Alive(worker_metrics.clone());
                while let Ok(message) = receiver.recv() {
                    match message {
                        Message::Line(line) => {
                            let start = Instant::now();
                            if sink(line).is_ok() {
                                worker_metrics.written.fetch_add(1, Ordering::Relaxed);
                            } else {
                                worker_metrics.io_failures.fetch_add(1, Ordering::Relaxed);
                            }
                            worker_metrics
                                .max_write_us
                                .fetch_max(start.elapsed().as_micros() as u64, Ordering::Relaxed);
                            worker_metrics.pending.fetch_sub(1, Ordering::Relaxed);
                        }
                        Message::Fence(reply) => {
                            let _ = reply.send(());
                        }
                    }
                }
            });
        if spawned.is_err() {
            metrics.alive.store(false, Ordering::Relaxed);
        }
        Self { sender, metrics }
    }
    pub fn submit(&self, line: String) {
        let start = Instant::now();
        self.metrics.submitted.fetch_add(1, Ordering::Relaxed);
        self.metrics.pending.fetch_add(1, Ordering::Relaxed);
        if self.sender.try_send(Message::Line(line)).is_err() {
            self.metrics.pending.fetch_sub(1, Ordering::Relaxed);
            self.metrics.dropped.fetch_add(1, Ordering::Relaxed);
        }
        self.metrics
            .max_enqueue_us
            .fetch_max(start.elapsed().as_micros() as u64, Ordering::Relaxed);
    }
    // Only export/test callers wait for a fence, never a native event handler.
    pub fn flush(&self, timeout: Duration) -> bool {
        let start = Instant::now();
        let (reply, wait) = mpsc::sync_channel(1);
        let mut message = Message::Fence(reply);
        loop {
            match self.sender.try_send(message) {
                Ok(()) => {
                    return wait
                        .recv_timeout(timeout.saturating_sub(start.elapsed()))
                        .is_ok()
                }
                Err(TrySendError::Disconnected(_)) => return false,
                Err(TrySendError::Full(returned)) => message = returned,
            }
            if start.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    pub fn status(&self) -> Value {
        let m = &self.metrics;
        json!({"submitted": m.submitted.load(Ordering::Relaxed), "written": m.written.load(Ordering::Relaxed),
            "dropped": m.dropped.load(Ordering::Relaxed), "pending": m.pending.load(Ordering::Relaxed),
            "ioFailures": m.io_failures.load(Ordering::Relaxed), "maxEnqueueMicros": m.max_enqueue_us.load(Ordering::Relaxed),
            "maxWriteMicros": m.max_write_us.load(Ordering::Relaxed), "alive": m.alive.load(Ordering::Relaxed)})
    }
}

fn append(directory: &Option<PathBuf>, max_bytes: u64, line: &str) -> std::io::Result<()> {
    let Some(dir) = directory else {
        return Err(std::io::ErrorKind::NotFound.into());
    };
    std::fs::create_dir_all(dir)?;
    let current = dir.join("events.jsonl");
    if std::fs::metadata(&current).map(|m| m.len()).unwrap_or(0) + line.len() as u64 + 1 > max_bytes
    {
        let oldest = dir.join("events.2.jsonl");
        if oldest.exists() {
            std::fs::remove_file(&oldest)?;
        }
        let previous = dir.join("events.1.jsonl");
        if previous.exists() {
            std::fs::rename(previous, oldest)?;
        }
        if current.exists() {
            std::fs::rename(&current, dir.join("events.1.jsonl"))?;
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(current)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn slow_disk_never_blocks_producers_and_overflow_is_visible() {
        let (started, wait_started) = mpsc::channel();
        let (release, wait_release) = mpsc::channel();
        let mut first = true;
        let writer = Writer::with_sink(2, move |_| {
            if first {
                first = false;
                started.send(()).unwrap();
                wait_release.recv().unwrap();
            }
            Ok(())
        });
        writer.submit("one".into());
        wait_started.recv_timeout(Duration::from_secs(1)).unwrap();
        writer.submit("two".into());
        writer.submit("three".into());
        writer.submit("dropped".into());
        assert_eq!(writer.status()["dropped"], 1);
        assert_eq!(writer.status()["pending"], 3);
        assert!(!writer.flush(Duration::from_millis(10)));
        release.send(()).unwrap();
        assert!(writer.flush(Duration::from_secs(2)));
        assert_eq!(writer.status()["written"], 3);
        assert_eq!(writer.status()["pending"], 0);
    }
}
