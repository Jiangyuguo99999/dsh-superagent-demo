// DSH Water - Cg water surface for Unity's Built-in Render Pipeline.
//
// The look target is a calm, slightly murky urban canal under a bright, hazy
// overcast sky: strong grazing-angle planar reflections with long wind streaks,
// a broken warm sun glitter path, and heavy distance fog.  Amplitudes stay in
// the centimetre range, so the result reads as a canal rather than an ocean.
//
// Required setup:
//   * Built-in Render Pipeline (Unity 2019.4 LTS or newer recommended).
//   * A PlanarReflection component on the water renderer, feeding
//     _ReflectionTex.  Without it the surface still renders, but reflects the
//     placeholder grey texture.
//   * The water object on the "Water" layer (layer 4 by default) so it is not
//     included in its own reflection.
//   * Scene fog enabled in Lighting settings.  The shader uses Unity's fog so
//     the water matches the rest of the scene automatically.
//
// The screenshot-matched demo scene can be created from
// Tools > DSH Water > Create Demo Scene.

Shader "DSH/Water"
{
    Properties
    {
        [Header(Water Body)]
        _DeepColor            ("Deep Water Color", Color) = (0.106, 0.149, 0.125, 1)
        _ScatterColor         ("Scatter / Murk Color", Color) = (0.180, 0.227, 0.180, 1)
        _ScatterStrength      ("Scatter Strength", Range(0, 2)) = 0.60
        _ReflectionTint       ("Reflection Tint", Color) = (0.824, 0.804, 0.753, 1)
        _ReflectionStrength   ("Reflection Strength", Range(0, 1.5)) = 1.0
        _ReflectionDistortion ("Reflection Distortion", Range(0, 0.4)) = 0.20
        _ReflectionBlur       ("Reflection Blur (mip)", Range(0, 4)) = 2.4
        _FresnelPower         ("Fresnel Power", Range(1, 8)) = 5.0
        _FresnelBias          ("Fresnel F0", Range(0, 0.2)) = 0.04

        [Header(Waves)]
        _WaveHeight           ("Wave Height", Range(0, 0.3)) = 0.16
        _WaveScale            ("Wave Scale", Range(0.25, 2)) = 1.0
        _WaveSpeed            ("Wave Speed", Range(0, 3)) = 0.80
        _NormalStrength       ("Normal Strength", Range(0, 2)) = 0.90
        _WindDirection        ("Wind Direction (XZ)", Vector) = (0.85, 0, 0.5, 0)

        [Header(Sun Glitter)]
        _SpecularColor        ("Sun Glitter Color", Color) = (1.0, 0.90, 0.72, 1)
        _SpecularIntensity    ("Broad Glitter", Range(0, 8)) = 1.20
        _SparkleIntensity     ("Sparkle Intensity", Range(0, 8)) = 2.60
        _SparklePower         ("Sparkle Power", Range(16, 2048)) = 120

        [Header(Reflection Source)]
        [NoScaleOffset] _ReflectionTex ("Planar Reflection (set by script)", 2D) = "gray" {}
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Opaque"
            "Queue" = "Geometry"
            "IgnoreProjector" = "True"
        }
        LOD 300

        Pass
        {
            Name "FORWARD"
            Tags { "LightMode" = "ForwardBase" }

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #pragma multi_compile_fwdbase
            #pragma multi_compile_fog

            #include "UnityCG.cginc"
            #include "Lighting.cginc"

            struct appdata
            {
                float4 vertex : POSITION;
            };

            struct v2f
            {
                float4 pos       : SV_POSITION;
                float3 worldPos  : TEXCOORD0;
                float4 screenPos : TEXCOORD1;
                UNITY_FOG_COORDS(2)
            };

            sampler2D _ReflectionTex;

            float4 _DeepColor;
            float4 _ScatterColor;
            float  _ScatterStrength;
            float4 _ReflectionTint;
            float  _ReflectionStrength;
            float  _ReflectionDistortion;
            float  _ReflectionBlur;
            float  _FresnelPower;
            float  _FresnelBias;

            float  _WaveHeight;
            float  _WaveScale;
            float  _WaveSpeed;
            float  _NormalStrength;
            float4 _WindDirection;

            float4 _SpecularColor;
            float  _SpecularIntensity;
            float  _SparkleIntensity;
            float  _SparklePower;

            // -----------------------------------------------------------------
            // Procedural wave field
            // -----------------------------------------------------------------
            float Hash21(float2 p)
            {
                p = frac(p * float2(123.34, 456.21));
                p += dot(p, p + 45.32);
                return frac(p.x * p.y);
            }

            float ValueNoise(float2 p)
            {
                float2 i = floor(p);
                float2 f = frac(p);
                f = f * f * (3.0 - 2.0 * f);
                float a = Hash21(i);
                float b = Hash21(i + float2(1.0, 0.0));
                float c = Hash21(i + float2(0.0, 1.0));
                float d = Hash21(i + float2(1.0, 1.0));
                return lerp(lerp(a, b, f.x), lerp(c, d, f.x), f.y);
            }

            float Fbm(float2 p)
            {
                return ValueNoise(p) * 0.65 + ValueNoise(p * 2.13 + 17.3) * 0.35;
            }

            // A slowly varying warp keeps the directional sines from reading
            // as a woven grid while preserving their analytic gradient.
            float2 WarpPoint(float2 p, float t)
            {
                float2 warp = float2(
                    ValueNoise(p * 0.12 + 3.1 + t * 0.012),
                    ValueNoise(p * 0.13 + 9.7 - t * 0.010)
                ) - 0.5;
                return p + warp * 0.7;
            }

            // h += amplitude * sin(dot(p, dir) * frequency + t * speed), and
            // accumulate dh/dp so normals need no finite differences for the
            // directional waves.
            void AddWave(
                float2 p, float2 dir, float frequency, float amplitude,
                float speed, float t, inout float2 grad)
            {
                float phase = dot(p, dir) * frequency + t * speed;
                grad += cos(phase) * amplitude * frequency * dir;
            }

            // Long swell plus the stretched wind-streak layer.  This normal
            // drives the reflection and the water body.
            float3 BaseNormal(float2 p, float t, float dist, float detail)
            {
                float2 wind = normalize(_WindDirection.xz + float2(1e-5, 1e-5));
                float2 perp = float2(-wind.y, wind.x);
                float2 q = WarpPoint(p, t) * _WaveScale;

                float2 waveGrad = float2(0.0, 0.0);
                AddWave(q, wind, 0.55, 0.34, 0.55, t, waveGrad);
                AddWave(q, normalize(wind + perp * 0.18), 0.95, 0.22, 0.85, t, waveGrad);
                AddWave(q, normalize(wind - perp * 0.12), 1.75, 0.11, 1.15, t, waveGrad);
                AddWave(q, normalize(wind + perp * 0.45), 3.40, 0.045 * detail, 1.50, t, waveGrad);
                AddWave(q, normalize(wind - perp * 0.30), 6.00, 0.020 * detail, 1.90, t, waveGrad);

                float2 grad = waveGrad * _WaveScale;

                // Wind streaks: long along the wind, compressed across it.
                float2 streakUV = float2(
                    dot(p, wind) * 0.10,
                    dot(p, perp) * 1.10 * _WaveScale);
                float e = 0.16;
                float n0 = Fbm(streakUV + float2(t * 0.030, t * 0.008));
                float nx = Fbm(streakUV + float2(e, 0.0) + float2(t * 0.030, t * 0.008));
                float nz = Fbm(streakUV + float2(0.0, e) + float2(t * 0.030, t * 0.008));
                float streak = 0.22 * detail * _WaveHeight;
                grad += float2((nx - n0) / e, (nz - n0) / e) * streak;

                float3 n = normalize(float3(-grad.x, 1.0, -grad.y));
                n.x *= _NormalStrength;
                n.z *= _NormalStrength;
                n = normalize(n);

                float flatten = saturate(dist / 260.0) * 0.60;
                return normalize(lerp(n, float3(0.0, 1.0, 0.0), flatten));
            }

            // Irregular capillary ripples.  These are used for the sun glitter
            // only; keeping them out of the reflection normal leaves the
            // mirror image readable while still breaking up the highlight.
            float3 DetailNormal(float2 p, float t, float detail)
            {
                float2 wind = normalize(_WindDirection.xz + float2(1e-5, 1e-5));
                float2 perp = float2(-wind.y, wind.x);
                float2 q = WarpPoint(p, t) * _WaveScale;

                float2 waveGrad = float2(0.0, 0.0);
                AddWave(q, normalize(wind + perp * 0.70), 10.00, 0.008, 2.40, t, waveGrad);
                AddWave(q, normalize(wind - perp * 0.05), 22.00, 0.014, 4.00, t, waveGrad);
                AddWave(q, normalize(wind + perp * 0.22), 35.00, 0.008, 5.00, t, waveGrad);

                float2 grad = waveGrad * _WaveScale;

                float2 fineUV = float2(
                    dot(p, wind) * 3.0,
                    dot(p, perp) * 8.0) * _WaveScale;
                float e = 0.035;
                float n0 = ValueNoise(fineUV + t * 0.60) * 0.035 +
                           ValueNoise(fineUV * 2.1 - t * 0.90 + 11.3) * 0.012;
                float nx = ValueNoise(fineUV + float2(e, 0.0) + t * 0.60) * 0.035 +
                           ValueNoise(fineUV * 2.1 + float2(e * 2.1, 0.0) - t * 0.90 + 11.3) * 0.012;
                float nz = ValueNoise(fineUV + float2(0.0, e) + t * 0.60) * 0.035 +
                           ValueNoise(fineUV * 2.1 + float2(0.0, e * 2.1) - t * 0.90 + 11.3) * 0.012;
                grad += float2((nx - n0) / e, (nz - n0) / e) * _WaveHeight * detail;

                return normalize(float3(-grad.x, 1.0, -grad.y));
            }

            v2f vert(appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.worldPos = mul(unity_ObjectToWorld, v.vertex).xyz;
                o.screenPos = ComputeScreenPos(o.pos);
                UNITY_TRANSFER_FOG(o, o.pos);
                return o;
            }

            float4 frag(v2f i) : SV_Target
            {
                float2 p = i.worldPos.xz;
                float t = _Time.y * _WaveSpeed;
                float dist = distance(_WorldSpaceCameraPos, i.worldPos);

                // Fine detail fades with distance and with the pixel footprint.
                // The latter stops procedural normals from shimmering or
                // forming a moire grid on a large plane.
                float detail = lerp(0.35, 1.0, saturate(1.0 - dist / 120.0));
                float footprint = max(fwidth(i.worldPos.x), fwidth(i.worldPos.z));
                detail *= saturate(1.0 - footprint * 6.0);

                float3 N = BaseNormal(p, t, dist, detail);
                float3 NFine = DetailNormal(p, t, detail);
                float3 NSpec = normalize(float3(N.xz * 1.4 + NFine.xz * 1.8, 1.0));

                float3 V = normalize(_WorldSpaceCameraPos - i.worldPos);
                float3 L = normalize(_WorldSpaceLightPos0.xyz + float3(0.0, 1e-4, 0.0));
                float3 halfDir = normalize(L + V);

                float NdotV = saturate(dot(N, V));
                float NdotL = saturate(dot(N, L));
                float NdotH = saturate(dot(NSpec, halfDir));

                // -------------------------------------------------------------
                // Fresnel + planar reflection
                // -------------------------------------------------------------
                float fresnel = _FresnelBias +
                    (1.0 - _FresnelBias) * pow(1.0 - NdotV, _FresnelPower);
                fresnel = saturate(fresnel * _ReflectionStrength);

                float2 screenUV = i.screenPos.xy / i.screenPos.w;
                float2 reflNormal = N.xz * 0.75 + NFine.xz * 0.45;
                float2 distortion = reflNormal * _ReflectionDistortion *
                    lerp(0.65, 1.45, saturate(dist / 80.0));
                distortion.y *= 1.5;

                float2 reflUV = clamp(screenUV + distortion,
                                      float2(0.002, 0.002), float2(0.998, 0.998));
                float lod = saturate(dist / 120.0) * _ReflectionBlur;
                float3 reflection = tex2Dlod(
                    _ReflectionTex, float4(reflUV, 0.0, lod)).rgb;
                reflection *= _ReflectionTint.rgb;

                // -------------------------------------------------------------
                // Water body color
                // -------------------------------------------------------------
                float3 water = _DeepColor.rgb;
                float3 scatter = _ScatterColor.rgb * _ScatterStrength;
                water = lerp(water, scatter, saturate(NdotV * 0.85));
                water *= lerp(0.70, 1.15, NdotL);

                float3 color = lerp(water, reflection, fresnel);

                // -------------------------------------------------------------
                // Sun glitter
                // -------------------------------------------------------------
                float sparkleMask = smoothstep(
                    0.30, 0.76,
                    ValueNoise(p * 2.2 + float2(t * 0.10, -t * 0.07)));

                float broad = pow(NdotH, 42.0) * _SpecularIntensity;
                float sparkle = pow(NdotH, _SparklePower) *
                    _SparkleIntensity * sparkleMask;
                float specular = (broad * 0.45 + sparkle) * NdotL *
                    (0.30 + 0.70 * fresnel);

                color += _LightColor0.rgb * _SpecularColor.rgb * specular;

                // Soft glow toward the sun so the glitter does not look like
                // isolated white pixels on an overcast day.
                float sunAlign = pow(saturate(dot(V, L)), 12.0);
                color += _LightColor0.rgb * _SpecularColor.rgb * sunAlign * 0.035;

                UNITY_APPLY_FOG(i.fogCoord, color);
                return float4(color, 1.0);
            }
            ENDCG
        }
    }

    Fallback Off
}
