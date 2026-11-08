// The probe compiles into the Editor and development builds only. Release builds keep the
// public API below as empty methods, so game code that calls it compiles everywhere.
// Add the scripting define PLAYPILOT_DISABLE to compile the probe out of every build.
#if (DEVELOPMENT_BUILD || UNITY_EDITOR) && !PLAYPILOT_DISABLE
#define PLAYPILOT_PROBE
#endif

using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace PlayPilotKit
{
    /// <summary>
    /// A tappable area the game draws itself (for example a world-space object), reported
    /// through <see cref="PlayPilot.RegisterTargetProvider"/>.
    /// </summary>
    public struct PlayPilotTarget
    {
        /// <summary>Stable id, unique on screen (for example "shop.buy"). Targets without an id are skipped.</summary>
        public string id;

        /// <summary>Human-readable text shown to the agent (for example "Buy").</summary>
        public string label;

        /// <summary>Free-form kind such as "button" or "item". Defaults to "custom" when empty.</summary>
        public string kind;

        /// <summary>
        /// Area in screen pixels, Unity screen space: origin at the bottom left, the same space
        /// <c>Camera.WorldToScreenPoint</c> and <c>Input.mousePosition</c> use. The probe clips it to the
        /// screen and converts it to the protocol's top-left fractions.
        /// </summary>
        public Rect screenRect;

        public PlayPilotTarget(string id, string label, string kind, Rect screenRect)
        {
            this.id = id;
            this.label = label;
            this.kind = kind;
            this.screenRect = screenRect;
        }
    }

    /// <summary>
    /// Static entry point of the PlayPilot game probe. Call it from the main thread
    /// (<see cref="ReportFinding"/> may be called from any thread).
    /// </summary>
    public static class PlayPilot
    {
        /// <summary>
        /// Master switch. Read at startup to decide whether the probe is created; turning it off later
        /// pauses all probe work. Always false in release builds, where the probe is not compiled.
        /// </summary>
#if PLAYPILOT_PROBE
        public static bool Enabled = true;
#else
        public static bool Enabled = false;
#endif

        /// <summary>Also report Unity warnings as "warning" events. Off by default.</summary>
        public static bool ReportWarnings = false;

        /// <summary>
        /// Also print a <c>PLAYPILOT {...}</c> line to the log whenever scene, screen or busy change, for
        /// people reading device logs. PlayPilot itself reads the files, not these lines. Off by default.
        /// </summary>
        public static bool LogLines = false;

        /// <summary>Sets the finer-grained location, such as a menu or panel name. Null or empty clears it.</summary>
        public static void SetScreen(string screen)
        {
#if PLAYPILOT_PROBE
            screen = screen ?? "";
            if (screen == s_Screen) return;
            s_Screen = screen;
            s_Version++;
#endif
        }

        /// <summary>
        /// Shares a small value with the agent. Strings, booleans and numbers are kept as they are;
        /// anything else is stored as its ToString() text.
        /// </summary>
        public static void SetFact(string key, object value)
        {
#if PLAYPILOT_PROBE
            if (key == null) throw new ArgumentNullException(nameof(key));
            value = NormalizeFact(value);
            if (s_Facts.TryGetValue(key, out object old) && Equals(old, value)) return;
            s_Facts[key] = value;
            s_Version++;
#endif
        }

        /// <summary>Removes a fact set with <see cref="SetFact"/>.</summary>
        public static void ClearFact(string key)
        {
#if PLAYPILOT_PROBE
            if (key != null && s_Facts.Remove(key)) s_Version++;
#endif
        }

        /// <summary>
        /// Marks the game as busy (for example while loading), so the agent waits before it observes.
        /// The probe also reports busy on its own while an action runs.
        /// </summary>
        public static void SetBusy(bool busy)
        {
#if PLAYPILOT_PROBE
            if (busy == s_GameBusy) return;
            s_GameBusy = busy;
            s_Version++;
#endif
        }

        /// <summary>
        /// Registers a multi-frame action, run as a coroutine on the probe. <paramref name="run"/> gets the
        /// command's args (numbers arrive as double). Yield a string to set the ack message (it also waits
        /// one frame). An exception fails the command with its message. Registering an existing id replaces it.
        /// </summary>
        public static void RegisterAction(string id, string description, Func<IDictionary<string, object>, IEnumerator> run)
        {
#if PLAYPILOT_PROBE
            if (id == null) throw new ArgumentNullException(nameof(id));
            if (run == null) throw new ArgumentNullException(nameof(run));
            int index = FindActionIndex(id);
            var entry = new ActionEntry(id, description ?? "", run);
            if (index >= 0) s_Actions[index] = entry;
            else s_Actions.Add(entry);
            s_Version++;
#endif
        }

        /// <summary>Registers an action that completes within the frame it is called.</summary>
        public static void RegisterAction(string id, string description, Action<IDictionary<string, object>> run)
        {
#if PLAYPILOT_PROBE
            if (run == null) throw new ArgumentNullException(nameof(run));
            RegisterAction(id, description, args =>
            {
                run(args);
                return (IEnumerator)null; // null tells the probe the action has already finished
            });
#endif
        }

        /// <summary>Removes an action. Unknown ids are ignored.</summary>
        public static void UnregisterAction(string id)
        {
#if PLAYPILOT_PROBE
            int index = id == null ? -1 : FindActionIndex(id);
            if (index < 0) return;
            s_Actions.RemoveAt(index);
            s_Version++;
#endif
        }

        /// <summary>
        /// Reports a broken invariant the game detected itself (level "finding" in events.jsonl).
        /// Safe to call from any thread.
        /// </summary>
        public static void ReportFinding(string message, string detail = null)
        {
#if PLAYPILOT_PROBE
            if (Enabled) EnqueueEvent("finding", message, detail, false);
#endif
        }

        /// <summary>
        /// Adds a callback that lists extra targets the game draws itself. It is called a few times a
        /// second on the main thread; keep it cheap. These targets are listed before the automatic uGUI ones.
        /// </summary>
        public static void RegisterTargetProvider(Func<IEnumerable<PlayPilotTarget>> provider)
        {
#if PLAYPILOT_PROBE
            if (provider == null) throw new ArgumentNullException(nameof(provider));
            if (!s_TargetProviders.Contains(provider)) s_TargetProviders.Add(provider);
#endif
        }

        /// <summary>Removes a callback added with <see cref="RegisterTargetProvider"/>.</summary>
        public static void UnregisterTargetProvider(Func<IEnumerable<PlayPilotTarget>> provider)
        {
#if PLAYPILOT_PROBE
            s_TargetProviders.Remove(provider);
#endif
        }

#if PLAYPILOT_PROBE
        // ------------------------------------------------------------ shared state read by the probe

        internal sealed class ActionEntry
        {
            public readonly string Id;
            public readonly string Description;
            public readonly Func<IDictionary<string, object>, IEnumerator> Run;

            public ActionEntry(string id, string description, Func<IDictionary<string, object>, IEnumerator> run)
            {
                Id = id;
                Description = description;
                Run = run;
            }
        }

        internal struct PendingEvent
        {
            public string Level;
            public string Message;
            public string Detail;
            public bool Dedupe; // engine log messages are deduplicated, findings are not
        }

        internal const int MaxTextLength = 2000;
        const int MaxPendingEvents = 1000;

        static string s_Screen = "";
        static bool s_GameBusy;
        static readonly Dictionary<string, object> s_Facts = new Dictionary<string, object>();
        static readonly List<ActionEntry> s_Actions = new List<ActionEntry>();
        static readonly List<Func<IEnumerable<PlayPilotTarget>>> s_TargetProviders = new List<Func<IEnumerable<PlayPilotTarget>>>();
        static readonly List<PendingEvent> s_PendingEvents = new List<PendingEvent>();
        static int s_Version;

        /// <summary>Increases whenever screen, facts, actions or the game busy flag change.</summary>
        internal static int Version => s_Version;
        internal static string CurrentScreen => s_Screen;
        internal static bool GameBusy => s_GameBusy;
        internal static Dictionary<string, object> Facts => s_Facts;
        internal static List<ActionEntry> Actions => s_Actions;
        internal static List<Func<IEnumerable<PlayPilotTarget>>> TargetProviders => s_TargetProviders;

        internal static ActionEntry FindAction(string id)
        {
            int index = FindActionIndex(id);
            return index >= 0 ? s_Actions[index] : null;
        }

        /// <summary>Moves all queued events into <paramref name="into"/>. Main thread.</summary>
        internal static void DrainEvents(List<PendingEvent> into)
        {
            lock (s_PendingEvents)
            {
                if (s_PendingEvents.Count == 0) return;
                into.AddRange(s_PendingEvents);
                s_PendingEvents.Clear();
            }
        }

        static int FindActionIndex(string id)
        {
            for (int i = 0; i < s_Actions.Count; i++)
                if (s_Actions[i].Id == id) return i;
            return -1;
        }

        static object NormalizeFact(object value)
        {
            if (value == null) return null;
            if (value is Enum) return value.ToString(); // enums report a TypeCode of their underlying integer
            switch (Convert.GetTypeCode(value))
            {
                case TypeCode.String:
                case TypeCode.Boolean:
                case TypeCode.SByte:
                case TypeCode.Byte:
                case TypeCode.Int16:
                case TypeCode.UInt16:
                case TypeCode.Int32:
                case TypeCode.UInt32:
                case TypeCode.Int64:
                case TypeCode.UInt64:
                case TypeCode.Single:
                case TypeCode.Double:
                case TypeCode.Decimal:
                    return value;
                default:
                    return value.ToString();
            }
        }

        static void EnqueueEvent(string level, string message, string detail, bool dedupe)
        {
            var e = new PendingEvent
            {
                Level = level,
                Message = Truncate(message ?? ""),
                Detail = string.IsNullOrEmpty(detail) ? null : Truncate(detail),
                Dedupe = dedupe,
            };
            lock (s_PendingEvents)
            {
                // Bounded so a flood before the probe starts (or while it is paused) cannot grow forever.
                if (s_PendingEvents.Count < MaxPendingEvents) s_PendingEvents.Add(e);
            }
        }

        static string Truncate(string text)
        {
            if (text.Length <= MaxTextLength) return text;
            int cut = MaxTextLength;
            if (char.IsHighSurrogate(text[cut - 1])) cut--; // never split a surrogate pair
            return text.Substring(0, cut);
        }

        // Runs on whatever thread logged the message.
        static void OnLogMessage(string condition, string stackTrace, LogType type)
        {
            if (!Enabled) return;
            string level;
            switch (type)
            {
                case LogType.Exception:
                case LogType.Assert:
                    level = "exception";
                    break;
                case LogType.Error:
                    level = "error";
                    break;
                case LogType.Warning:
                    if (!ReportWarnings) return;
                    level = "warning";
                    break;
                default:
                    return;
            }
            EnqueueEvent(level, condition, stackTrace, true);
        }

        // Clears state left over from a previous play session when domain reload is disabled.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetState()
        {
            Application.logMessageReceivedThreaded -= OnLogMessage;
            s_Screen = "";
            s_GameBusy = false;
            s_Facts.Clear();
            s_Actions.Clear();
            s_TargetProviders.Clear();
            lock (s_PendingEvents) s_PendingEvents.Clear();
            s_Version++;
        }

        // Listens before the first scene loads so errors from its Awake and OnEnable are kept;
        // they are queued until the probe starts after the scene load.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void ListenToLogs()
        {
            if (!Enabled) return;
            Application.logMessageReceivedThreaded -= OnLogMessage;
            Application.logMessageReceivedThreaded += OnLogMessage;
        }
#endif
    }
}
