using UnityEngine;

namespace PlayPilotKit
{
    /// <summary>
    /// Optional: overrides the id and label PlayPilot reports for the uGUI Selectable on the same
    /// GameObject. Empty fields keep the defaults (hierarchy path as id; child Text, then the
    /// GameObject name, as label). Compiled in every build so scenes that use it load everywhere;
    /// it does nothing on its own.
    /// </summary>
    [DisallowMultipleComponent]
    [AddComponentMenu("PlayPilot/PlayPilot Label")]
    public sealed class PlayPilotLabel : MonoBehaviour
    {
        [Tooltip("Stable target id, for example \"pause.resume\". Empty uses the hierarchy path.")]
        public string id = "";

        [Tooltip("Text shown to the agent. Empty uses the first child Text, then the GameObject name.")]
        public string label = "";
    }
}
