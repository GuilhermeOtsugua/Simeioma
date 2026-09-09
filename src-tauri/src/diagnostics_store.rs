//! Debug-only, content-free diagnostic storage. No network transport.
use crate::diagnostics_writer::Writer;
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    hash::{Hash, Hasher},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct Store {
    pub session: String,
    pub sequence: u64,
    pub events: VecDeque<Value>,
    pub directory: Option<PathBuf>,
    pub writer: Writer,
    pub max_record_micros: u64,
    capacity: usize,
    instances: BTreeMap<String, u64>,
    next_instance: u64,
}

impl Store {
    pub fn new(directory: Option<PathBuf>, max_bytes: u64, capacity: usize) -> Self {
        Self {
            session: format!("{}-{}", now_ms(), std::process::id()),
            sequence: 0,
            events: VecDeque::new(),
            writer: Writer::new(directory.clone(), max_bytes),
            directory,
            max_record_micros: 0,
            capacity,
            instances: BTreeMap::new(),
            next_instance: 0,
        }
    }

    pub fn instance(&mut self, label: &str) -> u64 {
        if let Some(id) = self.instances.get(label) {
            return *id;
        }
        if self.instances.len() >= 128 {
            return 0;
        }
        self.next_instance += 1;
        self.instances.insert(label.into(), self.next_instance);
        self.next_instance
    }

    pub fn current_instance(&self, label: &str) -> Option<u64> {
        self.instances.get(label).copied()
    }
    pub fn retire(&mut self, label: &str) {
        self.instances.remove(label);
    }

    // Session-scoped pseudonyms allow note/window matching without exporting stored IDs.
    pub fn alias(&self, label: &str) -> String {
        if matches!(label, "main" | "settings" | "notes-list" | "text-menu") {
            return label.into();
        }
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        self.session.hash(&mut hash);
        label.hash(&mut hash);
        format!("window-{:016x}", hash.finish())
    }

    pub fn record(&mut self, label: &str, event: &str, data: Value) {
        self.record_from("native", label, event, data);
    }

    pub fn record_frontend(&mut self, label: &str, event: &str, data: Value) {
        self.record_from("frontend", label, event, data);
    }

    fn record_from(&mut self, source: &str, label: &str, event: &str, data: Value) {
        let start = std::time::Instant::now();
        self.sequence += 1;
        let instance = self.instance(label);
        let entry = json!({"session": self.session, "sequence": self.sequence, "timestamp": now_ms(),
            "instance": instance, "source": source, "window": self.alias(label), "event": event, "data": sanitize(&data, 0)});
        if self.events.len() >= self.capacity {
            self.events.pop_front();
        }
        self.events.push_back(entry.clone());
        self.writer.submit(entry.to_string());
        self.max_record_micros = self
            .max_record_micros
            .max(start.elapsed().as_micros() as u64);
    }
}

// Unknown keys and all free-form strings are rejected, including exception messages.
pub fn sanitize(value: &Value, depth: usize) -> Value {
    let mut clean = Map::new();
    if depth > 4 {
        return Value::Object(clean);
    }
    if let Some(fields) = value.as_object() {
        for (key, value) in fields.iter().take(64) {
            let allowed = match key.as_str() {
                "menuOpen" | "confirmingExit" | "dragging" | "configuring" | "focused"
                | "visible" | "clipped" | "broadcast" | "failed" | "fail" | "busy"
                | "mouseDown" | "clamping" => value.is_boolean(),
                "width" | "height" | "x" | "y" | "top" | "right" | "bottom" | "left" | "scale"
                | "operationId" | "pending" | "capturedAt" | "requestId" | "revision"
                | "noteCount" | "importantCount" | "taskCount" | "clientSequence"
                | "durationMs" | "delayMs" | "line" | "column" | "clippingAncestors"
                | "commandId" | "transportFailures" | "dropped" | "errorKind" | "rendererId"
                | "emittedAt" | "operationAgeMs" | "dragId" | "dragAgeMs" | "motionAgeMs"
                | "roleCode" | "modeCode" => {
                    value.is_number()
                }
                "viewport" | "dialog" | "launcher" | "persistence" | "anchor" | "requested"
                | "actual" | "position" | "workArea" | "snapshot" | "drag" | "native" | "size" => {
                    if value.is_object() {
                        clean.insert(key.clone(), sanitize(value, depth + 1));
                    }
                    false
                }
                _ => false,
            };
            if allowed {
                clean.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(clean)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    #[ignore = "local timing measurement, not a CI latency assertion"]
    fn measure_recorder_producer() {
        let dir = std::env::temp_dir().join(format!("simeioma-recorder-benchmark-{}", now_ms()));
        let mut store = Store::new(Some(dir.clone()), 1024 * 1024, 500);
        let mut timings = Vec::new();
        for index in 0..500 {
            let start = std::time::Instant::now();
            store.record("main", "native-moved", json!({"x": 120, "y": 300}));
            timings.push(start.elapsed().as_micros());
            if index % 100 == 99 {
                assert!(store.writer.flush(std::time::Duration::from_secs(3)));
            }
        }
        assert!(store.writer.flush(std::time::Duration::from_secs(3)));
        assert_eq!(store.writer.status()["dropped"], 0);
        timings.sort();
        println!(
            "recorder producer microseconds: p50={} p95={} max={}",
            timings[250], timings[475], timings[499]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recorder_bounds_history_and_rotates_files() {
        let dir = std::env::temp_dir().join(format!("simeioma-diagnostics-test-{}", now_ms()));
        let mut store = Store::new(Some(dir.clone()), 384, 3);
        for _ in 0..20 {
            store.record("main", "snapshot", json!({"width": 64, "text": "secret"}));
        }
        assert_eq!(store.events.len(), 3);
        assert_eq!(store.sequence, 20);
        assert!(store.writer.flush(std::time::Duration::from_secs(3)));
        assert!(dir.join("events.1.jsonl").exists());
        assert!(dir.join("events.2.jsonl").exists());
        assert!(!dir.join("events.3.jsonl").exists());
        for file in ["events.jsonl", "events.1.jsonl", "events.2.jsonl"] {
            assert!(std::fs::metadata(dir.join(file)).unwrap().len() <= 384);
        }
        assert!(!std::fs::read_to_string(dir.join("events.jsonl"))
            .unwrap()
            .contains("secret"));
        assert_ne!(store.alias("note-private-id"), "note-private-id");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reopened_window_labels_receive_distinct_instances() {
        let mut store = Store::new(None, 1024, 3);
        store.record("settings", "native-focused", json!({}));
        let first = store.current_instance("settings").unwrap();
        store.retire("settings");
        store.record("settings", "native-focused", json!({}));
        let second = store.current_instance("settings").unwrap();
        assert_ne!(first, second);
        assert_eq!(store.events[0]["instance"], first);
        assert_eq!(store.events[1]["instance"], second);
        assert_eq!(store.events[0]["window"], store.events[1]["window"]);
    }

    #[test]
    fn unwritable_log_directory_keeps_memory_history() {
        let mut store = Store::new(None, 1024, 3);
        store.record("main", "snapshot", json!({"width": 360}));
        assert!(store.writer.flush(std::time::Duration::from_secs(1)));
        assert_eq!(store.writer.status()["ioFailures"], 1);
        assert_eq!(store.events.len(), 1);
    }

    #[test]
    fn snapshot_allowlist_drops_content_paths_and_unknown_fields() {
        let input = json!({
            "menuOpen": true, "viewport": {"width": 64, "height": 204},
            "text": "private note", "exportPath": "C:/Users/private", "error": "secret",
            "notes": [{"title": "private"}], "width": "private"
        });
        assert_eq!(
            sanitize(&input, 0),
            json!({
                "menuOpen": true, "viewport": {"width": 64, "height": 204}
            })
        );
    }
}
