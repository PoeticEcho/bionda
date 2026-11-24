CREATE TABLE weather (
  kind TEXT NOT NULL, location TEXT NOT NULL, hour INTEGER NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (kind, location, hour)
);
CREATE INDEX weather_time ON weather(at);
CREATE TABLE operations (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX operation_time ON operations(at);
