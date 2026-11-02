#if UNITY_EDITOR
using DSH.Water;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace DSH.Water.EditorTools
{
    /// <summary>
    /// Builds a self-contained demo scene that reproduces the mood of the
    /// reference canal: warm fog, blocky banks, a bridge, lamps and a water
    /// surface at the bottom of the frame.
    ///
    /// Menu: Tools > DSH Water > Create Demo Scene
    /// </summary>
    public static class WaterDemoBuilder
    {
        private const string DemoFolder = "Assets/Water/Demo";
        private const string MaterialFolder = DemoFolder + "/Materials";
        private const string ScenePath = DemoFolder + "/WaterDemo.unity";

        private static Material m_Concrete;
        private static Material m_WarmWall;
        private static Material m_PinkWall;
        private static Material m_DarkMetal;
        private static Material m_Green;
        private static Material m_WindowWarm;
        private static Material m_WindowCool;
        private static Material m_Lamp;

        [MenuItem("Tools/DSH Water/Create Demo Scene")]
        public static void CreateDemoScene()
        {
            Shader waterShader = Shader.Find("DSH/Water");
            if (waterShader == null)
            {
                EditorUtility.DisplayDialog(
                    "DSH Water",
                    "Could not find shader \"DSH/Water\".\n" +
                    "Make sure Assets/Water is inside the project and has finished importing.",
                    "OK");
                return;
            }

            if (!EditorUtility.DisplayDialog(
                    "Create DSH Water demo",
                    "Create a new demo scene at:\n" + ScenePath +
                    "\n\nUnsaved changes in the current scene will be lost.",
                    "Create", "Cancel"))
            {
                return;
            }

            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo())
                return;

            if (!AssetDatabase.IsValidFolder(DemoFolder))
                AssetDatabase.CreateFolder("Assets/Water", "Demo");
            if (!AssetDatabase.IsValidFolder(MaterialFolder))
                AssetDatabase.CreateFolder(DemoFolder, "Materials");

            if (!CreateMaterials())
                return;
            Scene scene = EditorSceneManager.NewScene(
                NewSceneSetup.EmptyScene, NewSceneMode.Single);

            ConfigureLighting();
            CreateCamera();
            CreateWater(waterShader);
            CreateCity();

            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();

            Selection.activeGameObject = GameObject.Find("Water");
            Debug.Log("[DSH Water] Demo scene created at " + ScenePath);
        }

        private static bool CreateMaterials()
        {
            Shader standard = Shader.Find("Standard");
            if (standard == null)
            {
                Debug.LogError("[DSH Water] The Built-in Render Pipeline Standard shader is missing.");
                return false;
            }

            m_Concrete = MakeMaterial("Concrete", standard,
                new Color(0.58f, 0.56f, 0.52f), 0f, 0.12f);
            m_WarmWall = MakeMaterial("WarmWall", standard,
                new Color(0.67f, 0.61f, 0.55f), 0f, 0.10f);
            m_PinkWall = MakeMaterial("PinkWall", standard,
                new Color(0.74f, 0.61f, 0.63f), 0f, 0.08f);
            m_DarkMetal = MakeMaterial("DarkMetal", standard,
                new Color(0.20f, 0.20f, 0.19f), 0.65f, 0.45f);
            m_Green = MakeMaterial("Foliage", standard,
                new Color(0.24f, 0.32f, 0.19f), 0f, 0.05f);

            m_WindowWarm = MakeEmissiveMaterial("WindowWarm", standard,
                new Color(0.13f, 0.11f, 0.09f), new Color(1.0f, 0.56f, 0.20f) * 2.4f);
            m_WindowCool = MakeEmissiveMaterial("WindowCool", standard,
                new Color(0.11f, 0.12f, 0.12f), new Color(0.92f, 0.85f, 0.68f) * 1.5f);
            m_Lamp = MakeEmissiveMaterial("SodiumLamp", standard,
                new Color(0.20f, 0.15f, 0.08f), new Color(1.0f, 0.62f, 0.24f) * 5.0f);
            return true;
        }

        private static Material MakeMaterial(
            string name, Shader shader, Color color, float metallic, float smoothness)
        {
            Material material = GetOrCreateMaterial(name, shader);
            material.SetColor("_Color", color);
            material.SetFloat("_Metallic", metallic);
            material.SetFloat("_Glossiness", smoothness);
            material.DisableKeyword("_EMISSION");
            material.SetColor("_EmissionColor", Color.black);
            EditorUtility.SetDirty(material);
            return material;
        }

        private static Material MakeEmissiveMaterial(
            string name, Shader shader, Color color, Color emission)
        {
            Material material = GetOrCreateMaterial(name, shader);
            material.SetColor("_Color", color);
            material.SetFloat("_Metallic", 0f);
            material.SetFloat("_Glossiness", 0.25f);
            material.EnableKeyword("_EMISSION");
            material.SetColor("_EmissionColor", emission);
            material.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
            EditorUtility.SetDirty(material);
            return material;
        }

        private static Material GetOrCreateMaterial(string name, Shader shader)
        {
            string path = MaterialFolder + "/" + name + ".mat";
            Material material = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (material == null)
            {
                material = new Material(shader) { name = name };
                AssetDatabase.CreateAsset(material, path);
            }
            else
            {
                material.shader = shader;
            }
            return material;
        }

        private static void ConfigureLighting()
        {
            GameObject sunObject = new GameObject("Sun");
            Light sun = sunObject.AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.color = new Color(1.0f, 0.91f, 0.79f);
            sun.intensity = 1.15f;
            sun.shadows = LightShadows.Soft;
            sunObject.transform.rotation = Quaternion.Euler(12f, 0f, 0f);
            RenderSettings.sun = sun;

            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.61f, 0.60f, 0.57f);
            RenderSettings.ambientEquatorColor = new Color(0.50f, 0.48f, 0.44f);
            RenderSettings.ambientGroundColor = new Color(0.27f, 0.26f, 0.23f);
            RenderSettings.ambientIntensity = 1.0f;

            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.ExponentialSquared;
            RenderSettings.fogDensity = 0.016f;
            RenderSettings.fogColor = new Color(0.72f, 0.69f, 0.62f);

            Shader skyShader = Shader.Find("Skybox/Procedural");
            if (skyShader != null)
            {
                Material sky = new Material(skyShader) { name = "HazySky" };
                sky.SetFloat("_SunSize", 0.035f);
                sky.SetFloat("_SunSizeConvergence", 4f);
                sky.SetFloat("_AtmosphereThickness", 1.55f);
                sky.SetColor("_SkyTint", new Color(0.56f, 0.56f, 0.56f));
                sky.SetColor("_GroundColor", new Color(0.45f, 0.43f, 0.40f));
                sky.SetFloat("_Exposure", 1.15f);
                string skyPath = MaterialFolder + "/HazySky.mat";
                Material skyAsset = AssetDatabase.LoadAssetAtPath<Material>(skyPath);
                if (skyAsset == null)
                {
                    AssetDatabase.CreateAsset(sky, skyPath);
                }
                else
                {
                    skyAsset.CopyPropertiesFromMaterial(sky);
                    Object.DestroyImmediate(sky);
                    sky = skyAsset;
                    EditorUtility.SetDirty(sky);
                }
                RenderSettings.skybox = sky;
            }

        }

        private static void CreateCamera()
        {
            GameObject cameraObject = new GameObject("Main Camera");
            cameraObject.tag = "MainCamera";

            Camera camera = cameraObject.AddComponent<Camera>();
            camera.transform.position = new Vector3(0f, 1.85f, 12f);
            camera.transform.rotation = Quaternion.Euler(2.2f, 0f, 0f);
            camera.fieldOfView = 58f;
            camera.nearClipPlane = 0.1f;
            camera.farClipPlane = 400f;
            camera.clearFlags = CameraClearFlags.Skybox;
            camera.allowHDR = true;
            camera.allowMSAA = true;

            cameraObject.AddComponent<AudioListener>();
        }

        private static void CreateWater(Shader waterShader)
        {
            GameObject water = GameObject.CreatePrimitive(PrimitiveType.Plane);
            water.name = "Water";
            water.layer = 4;
            water.transform.position = Vector3.zero;
            water.transform.localScale = new Vector3(30f, 1f, 30f);

            MeshRenderer renderer = water.GetComponent<MeshRenderer>();
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = false;

            string waterPath = MaterialFolder + "/DSHWaterDemo.mat";
            Material waterMaterial = AssetDatabase.LoadAssetAtPath<Material>(waterPath);
            if (waterMaterial == null)
            {
                waterMaterial = new Material(waterShader) { name = "DSHWaterDemo" };
                AssetDatabase.CreateAsset(waterMaterial, waterPath);
            }
            else
            {
                waterMaterial.shader = waterShader;
            }
            waterMaterial.SetColor("_DeepColor", new Color(0.106f, 0.149f, 0.125f, 1f));
            waterMaterial.SetColor("_ScatterColor", new Color(0.180f, 0.227f, 0.180f, 1f));
            waterMaterial.SetColor("_ReflectionTint", new Color(0.824f, 0.804f, 0.753f, 1f));
            waterMaterial.SetFloat("_ReflectionStrength", 1.0f);
            waterMaterial.SetFloat("_ReflectionDistortion", 0.20f);
            waterMaterial.SetFloat("_ReflectionBlur", 2.4f);
            waterMaterial.SetFloat("_FresnelPower", 5.0f);
            waterMaterial.SetFloat("_FresnelBias", 0.04f);
            waterMaterial.SetFloat("_WaveHeight", 0.16f);
            waterMaterial.SetFloat("_WaveScale", 1.0f);
            waterMaterial.SetFloat("_WaveSpeed", 0.80f);
            waterMaterial.SetFloat("_NormalStrength", 0.90f);
            waterMaterial.SetFloat("_SpecularIntensity", 1.2f);
            waterMaterial.SetFloat("_SparkleIntensity", 2.6f);
            waterMaterial.SetFloat("_SparklePower", 120f);
            waterMaterial.SetVector("_WindDirection", new Vector4(0.85f, 0f, 0.5f, 0f));
            EditorUtility.SetDirty(waterMaterial);
            renderer.sharedMaterial = waterMaterial;

            PlanarReflection reflection = water.AddComponent<PlanarReflection>();
            reflection.waterLayer = 4;
            reflection.reflectionMask = ~0;
            reflection.resolutionScale = 0.75f;
            reflection.reflectSkybox = true;
            reflection.clearColor = new Color(0.72f, 0.69f, 0.62f, 1f);
        }

        private static void CreateCity()
        {
            // Waterfront walls and quays.
            CreateBox("LeftWall", new Vector3(-11f, 1.35f, -30f),
                new Vector3(2f, 2.7f, 120f), m_Concrete);
            CreateBox("RightWall", new Vector3(11f, 1.35f, -30f),
                new Vector3(2f, 2.7f, 120f), m_Concrete);
            CreateBox("LeftQuay", new Vector3(-14.5f, 2.85f, -30f),
                new Vector3(8f, 0.3f, 120f), m_Concrete);
            CreateBox("RightQuay", new Vector3(14.5f, 2.85f, -30f),
                new Vector3(8f, 0.3f, 120f), m_Concrete);

            for (int i = 0; i < 5; i++)
            {
                float z = -2f - i * 18f;
                CreateBox("LeftPier" + i, new Vector3(-10.6f, 2.2f, z),
                    new Vector3(1.5f, 4.4f, 1.5f), m_Concrete);
                CreateBox("RightPier" + i, new Vector3(10.6f, 2.2f, z),
                    new Vector3(1.5f, 4.4f, 1.5f), m_Concrete);
            }

            // Left bank buildings.
            CreateBox("LeftBlockA", new Vector3(-24f, 10f, -14f),
                new Vector3(18f, 20f, 22f), m_WarmWall);
            CreateBox("LeftBlockB", new Vector3(-31f, 14f, -52f),
                new Vector3(26f, 28f, 28f), m_Concrete);
            CreateBox("LeftBlockC", new Vector3(-22f, 8f, -82f),
                new Vector3(16f, 16f, 20f), m_DarkMetal);

            // Right bank buildings.
            CreateBox("RightBlockA", new Vector3(25f, 12f, -22f),
                new Vector3(20f, 24f, 24f), m_PinkWall);
            CreateBox("RightBlockB", new Vector3(31f, 9f, -56f),
                new Vector3(28f, 18f, 26f), m_Concrete);
            CreateBox("RightBlockC", new Vector3(23f, 16f, -84f),
                new Vector3(18f, 32f, 22f), m_WarmWall);

            // Tower with antenna, loosely following the reference silhouette.
            CreateBox("Tower", new Vector3(-7f, 18f, -98f),
                new Vector3(15f, 36f, 15f), m_WarmWall);
            CreateBox("TowerTop", new Vector3(-7f, 37f, -98f),
                new Vector3(12f, 2f, 12f), m_Concrete);
            CreateBox("Antenna", new Vector3(-7f, 44f, -98f),
                new Vector3(0.25f, 12f, 0.25f), m_DarkMetal);

            // Bridge.
            CreateBox("BridgeDeck", new Vector3(0f, 8.5f, -42f),
                new Vector3(80f, 1.2f, 9f), m_Concrete);
            CreateBox("BridgeRailNear", new Vector3(0f, 10.1f, -37.7f),
                new Vector3(80f, 1.1f, 0.35f), m_DarkMetal);
            CreateBox("BridgeRailFar", new Vector3(0f, 10.1f, -46.3f),
                new Vector3(80f, 1.1f, 0.35f), m_DarkMetal);
            for (int i = 0; i < 4; i++)
            {
                float x = -8f + i * 5.33f;
                CreateBox("BridgePillar" + i, new Vector3(x, 4.1f, -42f),
                    new Vector3(2.2f, 8.2f, 6f), m_Concrete);
            }

            // Bank lamps and bridge lamps.
            for (int i = 0; i < 4; i++)
            {
                float z = -8f - i * 22f;
                CreateLamp(new Vector3(-10.5f, 2.85f, z), "LeftLamp" + i);
                CreateLamp(new Vector3(10.5f, 2.85f, z), "RightLamp" + i);
            }
            for (int i = 0; i < 4; i++)
            {
                float x = -30f + i * 20f;
                CreateLamp(new Vector3(x, 8.5f, -42f), "BridgeLamp" + i);
            }

            // Blocky tree on the left bank.
            CreateBox("TreeTrunk", new Vector3(-14.5f, 8f, -6f),
                new Vector3(1.1f, 12f, 1.1f), m_DarkMetal);
            CreateBox("TreeCrown", new Vector3(-14.5f, 15f, -6f),
                new Vector3(7f, 2.5f, 7f), m_Green);
            CreateBox("TreeCrown2", new Vector3(-14.5f, 17f, -7f),
                new Vector3(4.5f, 2f, 4.5f), m_Green);

            // Warm/cool windows on the facades that face the canal.
            AddWindowColumn(new Vector3(-14.85f, 0f, -8f), 4, 4.5f, 3.2f, true);
            AddWindowColumn(new Vector3(-17.85f, 0f, -44f), 5, 5.0f, 3.6f, false);
            AddWindowColumn(new Vector3(14.85f, 0f, -14f), 5, 4.5f, 3.2f, true);
            AddWindowColumn(new Vector3(16.85f, 0f, -50f), 4, 5.5f, 3.8f, false);
        }

        private static void CreateLamp(Vector3 basePosition, string name)
        {
            CreateBox(name + "Post", basePosition + new Vector3(0f, 2.6f, 0f),
                new Vector3(0.24f, 5.2f, 0.24f), m_DarkMetal);
            CreateBox(name + "Head", basePosition + new Vector3(0f, 5.35f, 0f),
                new Vector3(0.8f, 0.7f, 0.8f), m_Lamp);

            GameObject lightObject = new GameObject(name + "Light");
            lightObject.transform.position = basePosition + new Vector3(0f, 5.4f, 0f);
            Light light = lightObject.AddComponent<Light>();
            light.type = LightType.Point;
            light.color = new Color(1.0f, 0.62f, 0.26f);
            light.range = 22f;
            light.intensity = 2.2f;
            light.shadows = LightShadows.None;
        }

        private static void AddWindowColumn(
            Vector3 start, int floors, float floorHeight, float sizeZ, bool warm)
        {
            Material material = warm ? m_WindowWarm : m_WindowCool;
            for (int i = 0; i < floors; i++)
            {
                CreateBox("Window", start + new Vector3(0f, 3.5f + i * floorHeight, i * 0.4f),
                    new Vector3(0.12f, 1.5f, sizeZ), material);
            }
        }

        private static void CreateBox(
            string name, Vector3 position, Vector3 scale, Material material)
        {
            GameObject box = GameObject.CreatePrimitive(PrimitiveType.Cube);
            box.name = name;
            box.transform.position = position;
            box.transform.localScale = scale;

            Collider collider = box.GetComponent<Collider>();
            if (collider != null)
                Object.DestroyImmediate(collider);

            MeshRenderer renderer = box.GetComponent<MeshRenderer>();
            renderer.sharedMaterial = material;
        }
    }
}
#endif
