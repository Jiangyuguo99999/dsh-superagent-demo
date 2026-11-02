using UnityEngine;

namespace DSH.Water
{
    /// <summary>
    /// Renders the scene from a camera mirrored across the water plane and feeds
    /// the result to DSH/Water as _ReflectionTex.
    ///
    /// Setup:
    ///   1. Put the water object on the "Water" layer (layer 4 by default).
    ///   2. Add this component next to the MeshRenderer that uses DSH/Water.
    ///   3. Keep the water plane horizontal (its local up should point up).
    ///
    /// The component works in the editor as well as in play mode.
    /// </summary>
    [ExecuteAlways]
    [DisallowMultipleComponent]
    [RequireComponent(typeof(Renderer))]
    public class PlanarReflection : MonoBehaviour
    {
        [Header("Reflection")]
        [Tooltip("Layers that should appear in the reflection. Water layer is removed automatically.")]
        public LayerMask reflectionMask = ~0;

        [Tooltip("Layer of the water object. It must not render into its own reflection.")]
        [Range(0, 31)]
        public int waterLayer = 4;

        [Tooltip("Reflection render texture scale relative to the current camera.")]
        [Range(0.25f, 1f)]
        public float resolutionScale = 0.75f;

        [Tooltip("Reflect the scene skybox. Disable to use a flat clear color instead.")]
        public bool reflectSkybox = true;

        [Tooltip("Used when the reflected camera clears to a solid color.")]
        public Color clearColor = new Color(0.72f, 0.69f, 0.62f, 1f);

        [Tooltip("Small bias that keeps the mirrored near plane slightly above the water.")]
        [Range(0.01f, 0.5f)]
        public float clipPlaneOffset = 0.07f;

        private static readonly int ReflectionTexId = Shader.PropertyToID("_ReflectionTex");
        private static bool s_InsideRendering;

        private Camera m_ReflectionCamera;
        private RenderTexture m_ReflectionTexture;
        private Renderer m_Renderer;
        private Material m_Material;
        private int m_TextureWidth;
        private int m_TextureHeight;
        private RenderTextureFormat m_TextureFormat;

        private void OnEnable()
        {
            m_Renderer = GetComponent<Renderer>();
            m_Material = m_Renderer != null ? m_Renderer.sharedMaterial : null;
        }

        private void OnDisable()
        {
            ReleaseResources();
        }

        private void OnDestroy()
        {
            ReleaseResources();
        }

        private void OnValidate()
        {
            waterLayer = Mathf.Clamp(waterLayer, 0, 31);
            resolutionScale = Mathf.Clamp(resolutionScale, 0.25f, 1f);
            clipPlaneOffset = Mathf.Max(0.01f, clipPlaneOffset);
        }

        private void OnWillRenderObject()
        {
            if (!enabled || s_InsideRendering)
                return;

            Camera sourceCamera = Camera.current;
            if (sourceCamera == null)
                return;

            if (sourceCamera.cameraType == CameraType.Preview ||
                sourceCamera.cameraType == CameraType.Reflection)
                return;

            if (m_Renderer == null)
                m_Renderer = GetComponent<Renderer>();

            if (m_Renderer == null || !m_Renderer.enabled)
                return;

            m_Material = m_Renderer.sharedMaterial;
            if (m_Material == null || !m_Material.HasProperty(ReflectionTexId))
                return;

            // Reflections are only meaningful when the camera is above the
            // water plane.  Signed distance uses the plane's local up.
            Vector3 planeNormal = transform.up;
            Vector3 planePosition = transform.position;
            if (Vector3.Dot(planeNormal, sourceCamera.transform.position - planePosition) <= 0f)
                return;

            EnsureReflectionCamera();
            if (m_ReflectionCamera == null)
                return;

            int width = Mathf.Clamp(
                Mathf.RoundToInt(sourceCamera.pixelWidth * resolutionScale), 16, 2048);
            int height = Mathf.Clamp(
                Mathf.RoundToInt(sourceCamera.pixelHeight * resolutionScale), 16, 2048);

            RenderTextureFormat format = sourceCamera.allowHDR &&
                SystemInfo.SupportsRenderTextureFormat(RenderTextureFormat.DefaultHDR)
                ? RenderTextureFormat.DefaultHDR
                : RenderTextureFormat.Default;

            if (!EnsureTexture(width, height, format))
                return;

            RenderReflection(sourceCamera);
        }

        private void EnsureReflectionCamera()
        {
            if (m_ReflectionCamera != null)
                return;

            GameObject cameraObject = new GameObject("DSH Planar Reflection Camera");
            cameraObject.hideFlags = HideFlags.HideAndDontSave;

            m_ReflectionCamera = cameraObject.AddComponent<Camera>();
            m_ReflectionCamera.enabled = false;
            m_ReflectionCamera.allowMSAA = false;
            m_ReflectionCamera.useOcclusionCulling = false;
        }

        private bool EnsureTexture(int width, int height, RenderTextureFormat format)
        {
            if (m_ReflectionTexture != null &&
                m_TextureWidth == width &&
                m_TextureHeight == height &&
                m_TextureFormat == format)
            {
                return true;
            }

            ReleaseTexture();

            m_ReflectionTexture = new RenderTexture(width, height, 16, format,
                RenderTextureReadWrite.Default)
            {
                name = "DSH Water Reflection",
                hideFlags = HideFlags.DontSave,
                useMipMap = true,
                autoGenerateMips = true,
                filterMode = FilterMode.Trilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            m_ReflectionTexture.Create();

            if (!m_ReflectionTexture.IsCreated())
            {
                ReleaseTexture();
                return false;
            }

            m_TextureWidth = width;
            m_TextureHeight = height;
            m_TextureFormat = format;
            return true;
        }

        private void RenderReflection(Camera sourceCamera)
        {
            // Mirror the source camera's state, then override what must differ.
            m_ReflectionCamera.CopyFrom(sourceCamera);
            m_ReflectionCamera.enabled = false;
            m_ReflectionCamera.allowMSAA = false;
            m_ReflectionCamera.useOcclusionCulling = false;
            m_ReflectionCamera.targetTexture = m_ReflectionTexture;
            m_ReflectionCamera.depth = sourceCamera.depth - 1f;
            m_ReflectionCamera.rect = new Rect(0f, 0f, 1f, 1f);
            m_ReflectionCamera.cullingMask = reflectionMask.value & ~(1 << waterLayer);
            m_ReflectionCamera.clearFlags =
                reflectSkybox && RenderSettings.skybox != null
                    ? CameraClearFlags.Skybox
                    : CameraClearFlags.SolidColor;
            m_ReflectionCamera.backgroundColor = clearColor;

            Vector3 planePosition = transform.position;
            Vector3 planeNormal = transform.up;

            float planeOffset = -Vector3.Dot(planeNormal, planePosition) - clipPlaneOffset;
            Vector4 reflectionPlane = new Vector4(
                planeNormal.x, planeNormal.y, planeNormal.z, planeOffset);

            Matrix4x4 reflectionMatrix = Matrix4x4.zero;
            CalculateReflectionMatrix(ref reflectionMatrix, reflectionPlane);

            Vector3 mirroredPosition = reflectionMatrix.MultiplyPoint(
                sourceCamera.transform.position);

            // The view matrix is the ordinary source view, reflected through
            // the water plane.  Screen-space UVs in the shader then line up
            // without an explicit vertical flip.
            m_ReflectionCamera.worldToCameraMatrix =
                sourceCamera.worldToCameraMatrix * reflectionMatrix;

            Vector4 clipPlane = CameraSpacePlane(
                m_ReflectionCamera, planePosition, planeNormal, clipPlaneOffset, 1f);
            m_ReflectionCamera.projectionMatrix =
                m_ReflectionCamera.CalculateObliqueMatrix(clipPlane);

            // Keep the transform roughly on the mirrored side for culling and
            // shadow/bounds calculations.  Only a horizontal mirror is
            // supported, which is what a water plane needs.
            m_ReflectionCamera.transform.position = mirroredPosition;
            Vector3 sourceEuler = sourceCamera.transform.eulerAngles;
            m_ReflectionCamera.transform.eulerAngles =
                new Vector3(-sourceEuler.x, sourceEuler.y, sourceEuler.z);

            bool oldInvertCulling = GL.invertCulling;
            GL.invertCulling = true;
            s_InsideRendering = true;
            try
            {
                m_ReflectionCamera.Render();
            }
            finally
            {
                s_InsideRendering = false;
                GL.invertCulling = oldInvertCulling;
            }

            m_Material.SetTexture(ReflectionTexId, m_ReflectionTexture);
        }

        private void ReleaseTexture()
        {
            if (m_ReflectionTexture == null)
                return;

            if (m_ReflectionCamera != null)
                m_ReflectionCamera.targetTexture = null;

            m_ReflectionTexture.Release();
            DestroyImmediateSafe(m_ReflectionTexture);
            m_ReflectionTexture = null;
            m_TextureWidth = 0;
            m_TextureHeight = 0;
        }

        private void ReleaseResources()
        {
            if (m_Material != null && m_Material.HasProperty(ReflectionTexId))
                m_Material.SetTexture(ReflectionTexId, null);

            ReleaseTexture();

            if (m_ReflectionCamera != null)
            {
                if (m_ReflectionCamera.gameObject != null)
                    DestroyImmediateSafe(m_ReflectionCamera.gameObject);
                m_ReflectionCamera = null;
            }
        }

        private static void DestroyImmediateSafe(Object target)
        {
            if (target == null)
                return;

            if (Application.isPlaying)
                Object.Destroy(target);
            else
                Object.DestroyImmediate(target);
        }

        private static void CalculateReflectionMatrix(
            ref Matrix4x4 reflectionMatrix, Vector4 plane)
        {
            reflectionMatrix.m00 = 1f - 2f * plane[0] * plane[0];
            reflectionMatrix.m01 = -2f * plane[0] * plane[1];
            reflectionMatrix.m02 = -2f * plane[0] * plane[2];
            reflectionMatrix.m03 = -2f * plane[3] * plane[0];

            reflectionMatrix.m10 = -2f * plane[1] * plane[0];
            reflectionMatrix.m11 = 1f - 2f * plane[1] * plane[1];
            reflectionMatrix.m12 = -2f * plane[1] * plane[2];
            reflectionMatrix.m13 = -2f * plane[3] * plane[1];

            reflectionMatrix.m20 = -2f * plane[2] * plane[0];
            reflectionMatrix.m21 = -2f * plane[2] * plane[1];
            reflectionMatrix.m22 = 1f - 2f * plane[2] * plane[2];
            reflectionMatrix.m23 = -2f * plane[3] * plane[2];

            reflectionMatrix.m30 = 0f;
            reflectionMatrix.m31 = 0f;
            reflectionMatrix.m32 = 0f;
            reflectionMatrix.m33 = 1f;
        }

        private static Vector4 CameraSpacePlane(
            Camera camera, Vector3 position, Vector3 normal, float offset, float sideSign)
        {
            Vector3 offsetPosition = position + normal * offset * sideSign;
            Matrix4x4 worldToCamera = camera.worldToCameraMatrix;
            Vector3 cameraPosition = worldToCamera.MultiplyPoint(offsetPosition);
            Vector3 cameraNormal = worldToCamera.MultiplyVector(normal).normalized * sideSign;
            return new Vector4(
                cameraNormal.x, cameraNormal.y, cameraNormal.z,
                -Vector3.Dot(cameraPosition, cameraNormal));
        }
    }
}
