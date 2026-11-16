#if (DEVELOPMENT_BUILD || UNITY_EDITOR) && !PLAYPILOT_DISABLE
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace PlayPilotKit
{
    /// <summary>
    /// Runs the PlayPilot file channel (see docs/probe-protocol.md): writes state.json, appends
    /// events.jsonl and runs commands from inbox.json. Created automatically after the first scene loads.
    /// </summary>
    [AddComponentMenu("")] // created by code only
    internal sealed class PlayPilotProbe : MonoBehaviour
    {
        const double InboxPollInterval = 0.2;
        const double MinStateWriteInterval = 0.1; // at most 10 writes a second
        const double TargetScanInterval = 0.25;   // at most 4 scans a second
        const double DedupeWindow = 5.0;
        const int DedupePruneThreshold = 256;

        static PlayPilotProbe s_Instance;

        string _statePath;
        string _stateTempPath;
        string _eventsPath;
        string _inboxPath;
        bool _filesReady;
        bool _fileErrorLogged;

        readonly StringBuilder _body = new StringBuilder(1024);
        readonly StringBuilder _output = new StringBuilder(1024);
        readonly StringBuilder _targets = new StringBuilder(1024);
        readonly StringBuilder _eventLines = new StringBuilder(256);
        readonly List<PlayPilot.PendingEvent> _events = new List<PlayPilot.PendingEvent>();
        readonly Dictionary<string, double> _lastEmitted = new Dictionary<string, double>();
        readonly List<string> _expiredKeys = new List<string>();
        readonly PlayPilotTargetScanner _scanner = new PlayPilotTargetScanner();
        char[] _compareBuffer = new char[1024];

        string _scene = "";
        string _targetsJson = "[]";
        string _scannedScreen;
        string _lastBody;   // state.json content after "time", as last written
        string _lastLogLine;
        int _seq;
        int _seenVersion = -1;
        bool _dirty = true;
        double _lastWriteTime = double.NegativeInfinity;
        double _nextInboxPoll;
        double _nextTargetScan;

        bool _actionRunning;
        object _runningId;
        bool _hasAck;
        object _ackId; // echoed back exactly as received, whatever its JSON type
        bool _ackOk;
        string _ackMessage;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void CreateProbe()
        {
            if (!PlayPilot.Enabled || s_Instance != null) return;
            var go = new GameObject("PlayPilotProbe");
            DontDestroyOnLoad(go);
            go.AddComponent<PlayPilotProbe>();
        }

        void Awake()
        {
            if (s_Instance != null && s_Instance != this)
            {
                enabled = false; // skips OnEnable and LateUpdate until the destroy lands
                Destroy(gameObject);
                return;
            }
            s_Instance = this;
            OpenFileChannel();
        }

        void OnEnable()
        {
            SceneManager.activeSceneChanged += OnActiveSceneChanged;
            _scene = SceneManager.GetActiveScene().name ?? "";
            _dirty = true;
        }

        void OnDisable()
        {
            SceneManager.activeSceneChanged -= OnActiveSceneChanged;
            if (_actionRunning)
            {
                // Disabling stops the action's coroutine; fail it rather than stay busy forever.
                _actionRunning = false;
                SetAck(_runningId, false, "probe was disabled while the action ran");
            }
        }

        void OnDestroy()
        {
            if (s_Instance == this) s_Instance = null;
        }

        void OnActiveSceneChanged(Scene previous, Scene next)
        {
            _scene = next.name ?? "";
            _dirty = true;
            _nextTargetScan = 0; // rescan on the next frame
            _scanner.ForgetNames();
        }

        // LateUpdate so state reflects this frame's Update and coroutine work.
        void LateUpdate()
        {
            if (!PlayPilot.Enabled) return;
            double now = Time.realtimeSinceStartupAsDouble;

            FlushEvents(now);

            if (now >= _nextInboxPoll)
            {
                _nextInboxPoll = now + InboxPollInterval;
                // One command at a time: a command sent while an action runs waits in inbox.json.
                if (!_actionRunning) PollInbox();
            }

            // A new screen gets its targets in the same write, not up to a scan interval later.
            if (!ReferenceEquals(PlayPilot.CurrentScreen, _scannedScreen))
            {
                _scannedScreen = PlayPilot.CurrentScreen;
                _nextTargetScan = 0;
            }

            if (now >= _nextTargetScan)
            {
                _nextTargetScan = now + TargetScanInterval;
                ScanTargets();
            }

            if (PlayPilot.Version != _seenVersion)
            {
                _seenVersion = PlayPilot.Version;
                _dirty = true;
            }

            if (_dirty && now - _lastWriteTime >= MinStateWriteInterval)
                WriteState(now);
        }

        // ------------------------------------------------------------------ files

        void OpenFileChannel()
        {
            string folder = PlayPilot.Folder;
            _statePath = Path.Combine(folder, "state.json");
            _stateTempPath = _statePath + ".tmp";
            _eventsPath = Path.Combine(folder, "events.jsonl");
            _inboxPath = Path.Combine(folder, "inbox.json");
            try
            {
                Directory.CreateDirectory(folder);
                File.WriteAllText(_eventsPath, ""); // a new run starts a new event log
                if (File.Exists(_inboxPath)) File.Delete(_inboxPath); // never run a command left from an earlier run
                _filesReady = true;
            }
            catch (Exception e)
            {
                LogFileError(e);
            }
        }

        bool TryWriteState(string json)
        {
            try
            {
                File.WriteAllText(_stateTempPath, json);
                if (File.Exists(_statePath))
                {
                    try
                    {
                        File.Replace(_stateTempPath, _statePath, null); // atomic rename over the old file
                    }
                    catch (Exception e) when (e is PlatformNotSupportedException || e is NotSupportedException)
                    {
                        // Some platforms lack File.Replace. Delete then move is the closest fallback;
                        // a reader may briefly find no file, but never a partial one.
                        File.Delete(_statePath);
                        File.Move(_stateTempPath, _statePath);
                    }
                }
                else
                {
                    File.Move(_stateTempPath, _statePath);
                }
                return true;
            }
            catch (Exception e)
            {
                LogFileError(e);
                return false;
            }
        }

        void LogFileError(Exception e)
        {
            if (_fileErrorLogged) return; // once per run, so a broken disk does not flood the log
            _fileErrorLogged = true;
            Debug.LogWarning("PlayPilot probe: file channel error: " + e.Message);
        }

        // ------------------------------------------------------------------ events

        void FlushEvents(double now)
        {
            PlayPilot.DrainEvents(_events);
            if (_events.Count == 0) return;

            _eventLines.Clear();
            foreach (var e in _events)
            {
                if (e.Dedupe && IsRecentDuplicate(e, now)) continue;
                _eventLines.Append("{\"time\":");
                PlayPilotJson.WriteFixed4(_eventLines, now);
                _eventLines.Append(",\"level\":");
                PlayPilotJson.WriteString(_eventLines, e.Level);
                _eventLines.Append(",\"message\":");
                PlayPilotJson.WriteString(_eventLines, e.Message);
                if (e.Detail != null)
                {
                    _eventLines.Append(",\"detail\":");
                    PlayPilotJson.WriteString(_eventLines, e.Detail);
                }
                _eventLines.Append("}\n");
            }
            _events.Clear();

            if (_eventLines.Length == 0 || !_filesReady) return;
            try
            {
                File.AppendAllText(_eventsPath, _eventLines.ToString());
            }
            catch (Exception e)
            {
                LogFileError(e);
            }
        }

        /// <summary>True when the same message with the same first stack line was written in the last 5 s.</summary>
        bool IsRecentDuplicate(PlayPilot.PendingEvent e, double now)
        {
            string key = e.Level + "\n" + e.Message + "\n" + FirstLine(e.Detail);
            if (_lastEmitted.TryGetValue(key, out double last) && now - last < DedupeWindow) return true;
            _lastEmitted[key] = now;

            if (_lastEmitted.Count > DedupePruneThreshold)
            {
                foreach (var pair in _lastEmitted)
                    if (now - pair.Value >= DedupeWindow) _expiredKeys.Add(pair.Key);
                foreach (string expired in _expiredKeys) _lastEmitted.Remove(expired);
                _expiredKeys.Clear();
            }
            return false;
        }

        static string FirstLine(string text)
        {
            if (text == null) return "";
            int end = text.IndexOf('\n');
            return end < 0 ? text : text.Substring(0, end);
        }

        // ------------------------------------------------------------------ commands

        void PollInbox()
        {
            if (!_filesReady || !File.Exists(_inboxPath)) return;

            string text;
            try
            {
                text = File.ReadAllText(_inboxPath);
                File.Delete(_inboxPath); // delete before running, so a command never runs twice
            }
            catch (Exception e)
            {
                LogFileError(e);
                return; // the file is still there; retry on the next poll
            }

            Dictionary<string, object> command;
            try
            {
                command = PlayPilotJson.Parse(text) as Dictionary<string, object>;
            }
            catch (FormatException e)
            {
                SetAck(null, false, "inbox.json is not valid JSON: " + e.Message);
                return;
            }
            if (command == null)
            {
                SetAck(null, false, "inbox.json must hold a JSON object");
                return;
            }

            command.TryGetValue("id", out object id);
            command.TryGetValue("action", out object actionValue);
            command.TryGetValue("args", out object argsValue);
            string actionId = actionValue as string;

            IDictionary<string, object> args;
            if (argsValue == null) args = new Dictionary<string, object>();
            else if (argsValue is Dictionary<string, object> dict) args = dict;
            else
            {
                SetAck(id, false, "args must be a JSON object");
                return;
            }

            StartAction(id, actionId, args);
        }

        void StartAction(object id, string actionId, IDictionary<string, object> args)
        {
            PlayPilot.ActionEntry action = actionId == null ? null : PlayPilot.FindAction(actionId);
            if (action == null)
            {
                SetAck(id, false, "unknown action " + actionId);
                return;
            }

            IEnumerator body;
            try
            {
                body = action.Run(args);
            }
            catch (Exception e)
            {
                Debug.LogException(e); // also lands in events.jsonl with its stack trace
                SetAck(id, false, Describe(e));
                return;
            }

            if (body == null)
            {
                SetAck(id, true, "ok");
                return;
            }

            _actionRunning = true;
            _runningId = id; // remembered in case the probe is disabled mid-action
            _dirty = true;
            StartCoroutine(RunAction(id, body));
        }

        /// <summary>
        /// Steps the action by hand so its exceptions can be caught, including those inside nested
        /// IEnumerators it yields (which are run inline). Other yield values pass through to Unity.
        /// </summary>
        IEnumerator RunAction(object id, IEnumerator body)
        {
            var stack = new Stack<IEnumerator>();
            stack.Push(body);
            string message = "ok";

            while (stack.Count > 0)
            {
                object current = null;
                Exception error = null;
                bool stepped;
                try
                {
                    stepped = stack.Peek().MoveNext();
                    if (stepped) current = stack.Peek().Current;
                }
                catch (Exception e)
                {
                    error = e;
                    stepped = false;
                }

                if (error != null)
                {
                    Debug.LogException(error);
                    FinishAction(id, false, Describe(error));
                    yield break;
                }
                if (!stepped)
                {
                    stack.Pop();
                    continue;
                }
                if (current is IEnumerator nested)
                {
                    stack.Push(nested);
                    continue;
                }
                if (current is string text)
                {
                    message = text; // a yielded string becomes the ack message
                    current = null;
                }
                yield return current;
            }

            FinishAction(id, true, message);
        }

        void FinishAction(object id, bool ok, string message)
        {
            _actionRunning = false;
            SetAck(id, ok, message);
        }

        void SetAck(object id, bool ok, string message)
        {
            _hasAck = true;
            _ackId = id;
            _ackOk = ok;
            _ackMessage = message;
            _dirty = true;
        }

        static string Describe(Exception e) => e.GetType().Name + ": " + e.Message;

        // ------------------------------------------------------------------ state

        void ScanTargets()
        {
            _scanner.Scan(_targets);
            if (Matches(_targets, _targetsJson)) return;
            _targetsJson = _targets.ToString();
            _dirty = true;
        }

        void WriteState(double now)
        {
            bool busy = _actionRunning || PlayPilot.GameBusy;

            // Everything except seq and time, so an unchanged state is never rewritten.
            _body.Clear();
            _body.Append("\"scene\":");
            PlayPilotJson.WriteString(_body, _scene);
            _body.Append(",\"screen\":");
            PlayPilotJson.WriteString(_body, PlayPilot.CurrentScreen);
            _body.Append(",\"busy\":").Append(busy ? "true" : "false");
            _body.Append(",\"facts\":");
            PlayPilotJson.WriteValue(_body, PlayPilot.Facts);
            _body.Append(",\"targets\":").Append(_targetsJson);
            _body.Append(",\"actions\":[");
            var actions = PlayPilot.Actions;
            for (int i = 0; i < actions.Count; i++)
            {
                if (i > 0) _body.Append(',');
                _body.Append("{\"id\":");
                PlayPilotJson.WriteString(_body, actions[i].Id);
                _body.Append(",\"description\":");
                PlayPilotJson.WriteString(_body, actions[i].Description);
                _body.Append('}');
            }
            _body.Append(']');
            if (_hasAck)
            {
                _body.Append(",\"ack\":{\"id\":");
                PlayPilotJson.WriteValue(_body, _ackId);
                _body.Append(",\"ok\":").Append(_ackOk ? "true" : "false");
                _body.Append(",\"message\":");
                PlayPilotJson.WriteString(_body, _ackMessage);
                _body.Append('}');
            }

            _dirty = false;
            if (Matches(_body, _lastBody)) return;

            string body = _body.ToString();
            int seq = _seq + 1;
            _output.Clear();
            _output.Append("{\"v\":1,\"seq\":");
            PlayPilotJson.AppendInteger(_output, seq);
            _output.Append(",\"time\":");
            PlayPilotJson.WriteFixed4(_output, now);
            _output.Append(',').Append(body).Append('}');

            _lastWriteTime = now;
            // Without a file channel the state still counts as written, for the log lines below.
            if (_filesReady && !TryWriteState(_output.ToString()))
            {
                _dirty = true; // retry after the write interval
                return;
            }
            _seq = seq;
            _lastBody = body;

            if (PlayPilot.LogLines) WriteLogLine(seq, busy);
        }

        void WriteLogLine(int seq, bool busy)
        {
            _output.Clear();
            _output.Append(",\"scene\":");
            PlayPilotJson.WriteString(_output, _scene);
            _output.Append(",\"screen\":");
            PlayPilotJson.WriteString(_output, PlayPilot.CurrentScreen);
            _output.Append(",\"busy\":").Append(busy ? "true" : "false");
            if (Matches(_output, _lastLogLine)) return; // one line per change of place or busy
            _lastLogLine = _output.ToString();

            _output.Insert(0, "PLAYPILOT {\"v\":1,\"seq\":" + seq);
            _output.Append('}');
            Debug.LogFormat(LogType.Log, LogOption.NoStacktrace, null, "{0}", _output.ToString());
        }

        /// <summary>Compares a builder with a string without allocating (after the buffer has grown).</summary>
        bool Matches(StringBuilder sb, string text)
        {
            if (text == null || sb.Length != text.Length) return false;
            // CopyTo is linear; the StringBuilder indexer walks its chunk list on every call.
            if (_compareBuffer.Length < sb.Length) _compareBuffer = new char[sb.Length * 2];
            sb.CopyTo(0, _compareBuffer, 0, sb.Length);
            for (int i = 0; i < text.Length; i++)
                if (_compareBuffer[i] != text[i]) return false;
            return true;
        }
    }
}
#endif
