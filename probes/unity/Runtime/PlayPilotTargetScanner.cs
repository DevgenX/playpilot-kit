#if (DEVELOPMENT_BUILD || UNITY_EDITOR) && !PLAYPILOT_DISABLE
using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.UI;

namespace PlayPilotKit
{
    /// <summary>
    /// Lists the tappable targets on screen: those from registered target providers first, then every
    /// visible, interactable uGUI Selectable. Writes them as the protocol's "targets" JSON array.
    /// </summary>
    internal sealed class PlayPilotTargetScanner
    {
        const int MaxTargets = 60;
        const int MaxCachedNames = 1024;

        struct Names
        {
            public string Path; // hierarchy path, the default target id
            public string Name; // GameObject name, the last-resort label
        }

        Selectable[] _selectables = new Selectable[64];
        readonly Vector3[] _corners = new Vector3[4];
        readonly List<CanvasGroup> _groups = new List<CanvasGroup>();
        readonly HashSet<string> _usedIds = new HashSet<string>();
        readonly Dictionary<Type, string> _kinds = new Dictionary<Type, string>();
        // GameObject.name allocates on every call, so names are cached per object between scans.
        // A rename shows up after the next scene change.
        readonly Dictionary<int, Names> _names = new Dictionary<int, Names>();
        readonly StringBuilder _path = new StringBuilder(128);
        int _count;

        /// <summary>Drops cached object names (called on scene changes).</summary>
        public void ForgetNames() => _names.Clear();

        public void Scan(StringBuilder json)
        {
            json.Clear();
            json.Append('[');
            _count = 0;
            _usedIds.Clear();

            float width = Screen.width;
            float height = Screen.height;
            if (width > 0 && height > 0)
            {
                ScanProviders(json, width, height);
                ScanSelectables(json, width, height);
            }
            json.Append(']');
        }

        void ScanProviders(StringBuilder json, float width, float height)
        {
            var providers = PlayPilot.TargetProviders;
            for (int i = 0; i < providers.Count && _count < MaxTargets; i++)
            {
                try
                {
                    IEnumerable<PlayPilotTarget> targets = providers[i]();
                    if (targets == null) continue;
                    foreach (PlayPilotTarget t in targets)
                    {
                        if (_count >= MaxTargets) break;
                        if (string.IsNullOrEmpty(t.id)) continue;
                        Write(json, t.id, t.label ?? "", string.IsNullOrEmpty(t.kind) ? "custom" : t.kind, t.screenRect, width, height);
                    }
                }
                catch (Exception e)
                {
                    Debug.LogException(e); // reported as an event; the other providers still run
                }
            }
        }

        void ScanSelectables(StringBuilder json, float width, float height)
        {
            if (_selectables.Length < Selectable.allSelectableCount)
                _selectables = new Selectable[Mathf.NextPowerOfTwo(Selectable.allSelectableCount)];
            int count = Selectable.AllSelectablesNoAlloc(_selectables);

            for (int i = 0; i < count && _count < MaxTargets; i++)
            {
                Selectable s = _selectables[i];
                if (s == null || !s.IsInteractable() || !IsShownAndClickable(s)) continue;
                if (!TryGetScreenRect(s, out Rect rect)) continue;

                string id = null;
                string label = null;
                if (s.TryGetComponent(out PlayPilotLabel tag))
                {
                    if (!string.IsNullOrEmpty(tag.id)) id = tag.id;
                    if (!string.IsNullOrEmpty(tag.label)) label = tag.label;
                }
                if (label == null)
                {
                    Text text = s.GetComponentInChildren<Text>();
                    if (text != null && !string.IsNullOrWhiteSpace(text.text)) label = text.text;
                }
                if (id == null || label == null)
                {
                    Names names = GetNames(s.transform);
                    id = id ?? names.Path;
                    label = label ?? names.Name;
                }
                Write(json, id, label, KindOf(s), rect, width, height);
            }
            Array.Clear(_selectables, 0, count); // do not keep destroyed UI alive
        }

        /// <summary>
        /// False when a CanvasGroup above the Selectable hides it (alpha 0) or lets taps pass through
        /// (blocksRaycasts off). Interactable groups are covered by Selectable.IsInteractable.
        /// </summary>
        bool IsShownAndClickable(Selectable s)
        {
            s.GetComponentsInParent(false, _groups);
            bool result = true;
            foreach (CanvasGroup group in _groups)
            {
                if (!group.enabled) continue;
                if (group.alpha <= 0f || !group.blocksRaycasts)
                {
                    result = false;
                    break;
                }
                if (group.ignoreParentGroups) break;
            }
            _groups.Clear();
            return result;
        }

        /// <summary>Screen-pixel bounds (origin bottom left) of the Selectable's RectTransform.</summary>
        bool TryGetScreenRect(Selectable s, out Rect rect)
        {
            rect = default;
            Canvas canvas = s.GetComponentInParent<Canvas>();
            if (canvas == null || !canvas.isActiveAndEnabled) return false;
            Canvas root = canvas.rootCanvas;
            if (!root.isActiveAndEnabled) return false;

            Camera camera = null; // Screen Space - Overlay: world space is screen pixels
            if (root.renderMode != RenderMode.ScreenSpaceOverlay)
            {
                camera = root.worldCamera;
                // A camera-space canvas without a camera renders as an overlay; a world-space
                // canvas without one uses the main camera, as uGUI does for events.
                if (camera == null && root.renderMode == RenderMode.WorldSpace)
                {
                    camera = Camera.main;
                    if (camera == null) return false;
                }
            }

            if (!(s.transform is RectTransform rectTransform)) return false;
            rectTransform.GetWorldCorners(_corners);
            float minX = float.PositiveInfinity, minY = float.PositiveInfinity;
            float maxX = float.NegativeInfinity, maxY = float.NegativeInfinity;
            for (int i = 0; i < 4; i++)
            {
                Vector3 p = _corners[i];
                if (camera != null)
                {
                    p = camera.WorldToScreenPoint(p);
                    if (p.z < 0f) return false; // behind the camera
                }
                minX = Mathf.Min(minX, p.x);
                minY = Mathf.Min(minY, p.y);
                maxX = Mathf.Max(maxX, p.x);
                maxY = Mathf.Max(maxY, p.y);
            }
            rect = Rect.MinMaxRect(minX, minY, maxX, maxY);
            return true;
        }

        /// <summary>
        /// Clips <paramref name="rect"/> (screen pixels, origin bottom left) to the screen and writes it
        /// as centre and size fractions with the origin at the top left. Fully off-screen rects are skipped.
        /// </summary>
        void Write(StringBuilder json, string id, string label, string kind, Rect rect, float width, float height)
        {
            float minX = Mathf.Max(rect.xMin, 0f);
            float maxX = Mathf.Min(rect.xMax, width);
            float minY = Mathf.Max(rect.yMin, 0f);
            float maxY = Mathf.Min(rect.yMax, height);
            if (!(maxX > minX && maxY > minY)) return; // also rejects NaN

            if (!_usedIds.Add(id))
            {
                // Same id twice (for example identical list rows): suffix #2, #3, ...
                for (int n = 2; ; n++)
                {
                    string candidate = id + "#" + n;
                    if (_usedIds.Add(candidate))
                    {
                        id = candidate;
                        break;
                    }
                }
            }

            if (_count > 0) json.Append(',');
            _count++;
            json.Append("{\"id\":");
            PlayPilotJson.WriteString(json, id);
            json.Append(",\"label\":");
            PlayPilotJson.WriteString(json, label);
            json.Append(",\"kind\":");
            PlayPilotJson.WriteString(json, kind);
            json.Append(",\"x\":");
            PlayPilotJson.WriteFixed4(json, (minX + maxX) * 0.5 / width);
            json.Append(",\"y\":");
            PlayPilotJson.WriteFixed4(json, 1.0 - (minY + maxY) * 0.5 / height);
            json.Append(",\"w\":");
            PlayPilotJson.WriteFixed4(json, (maxX - minX) / width);
            json.Append(",\"h\":");
            PlayPilotJson.WriteFixed4(json, (maxY - minY) / height);
            json.Append('}');
        }

        string KindOf(Selectable s)
        {
            Type type = s.GetType();
            if (_kinds.TryGetValue(type, out string kind)) return kind;

            if (s is Button) kind = "button";
            else if (s is Toggle) kind = "toggle";
            else if (s is Slider) kind = "slider";
            else if (s is Scrollbar) kind = "scrollbar";
            else if (s is Dropdown) kind = "dropdown";
            else if (s is InputField) kind = "input";
            // Selectables from other packages (TextMesh Pro included) are matched by type name,
            // so this package does not depend on them.
            else if (type.Name.Contains("Dropdown")) kind = "dropdown";
            else if (type.Name.Contains("InputField")) kind = "input";
            else if (type.Name.Contains("Button")) kind = "button";
            else kind = "selectable";

            _kinds[type] = kind;
            return kind;
        }

        Names GetNames(Transform t)
        {
            int key = t.GetInstanceID();
            if (_names.TryGetValue(key, out Names names)) return names;
            if (_names.Count >= MaxCachedNames) _names.Clear();

            string name = t.name;
            _path.Clear();
            _path.Append(name);
            for (Transform node = t.parent; node != null; node = node.parent)
                _path.Insert(0, '/').Insert(0, node.name);
            names = new Names { Path = _path.ToString(), Name = name };
            _names[key] = names;
            return names;
        }
    }
}
#endif
