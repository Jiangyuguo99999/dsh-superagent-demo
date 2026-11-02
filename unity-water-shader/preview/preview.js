/* DSH Water — WebGL2 algorithm preview.
 *
 * This page is a verification harness, not the deliverable Unity project.
 * It reproduces the same wave field, planar-reflection sampling, Fresnel,
 * sun-glitter and fog math as Assets/Water/Shaders/DSHWater.shader so the look
 * can be reviewed in an environment without Unity.  The Unity shader and the
 * PlanarReflection script are the source of truth.
 */
(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const CAPTURE = params.get("capture") === "1";
  let mode = params.get("mode") === "before" ? "before" : "after";

  const canvas = document.getElementById("gl");
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    depth: true,
    preserveDrawingBuffer: true,
  });

  if (!gl) {
    document.querySelector(".note").textContent =
      "当前浏览器不支持 WebGL2，无法显示算法预览。";
    return;
  }

  // Supersampling is handy for evidence captures: render at 2x and let the
  // browser downsample to the CSS size.
  const SS = Math.min(2, Math.max(1, parseInt(params.get("ss") || "1", 10) || 1));
  canvas.width = 1280 * SS;
  canvas.height = 673 * SS;

  const W = canvas.width;
  const H = canvas.height;
  const REFL_W = Math.round(W * 0.55);
  const REFL_H = Math.round(H * 0.55);

  if (CAPTURE) document.body.classList.add("capture");

  // ---------------------------------------------------------------------------
  // Small math library (column-major, like WebGL)
  // ---------------------------------------------------------------------------
  const M4 = {
    identity() {
      return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    },
    multiply(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          o[r + c * 4] =
            a[r] * b[c * 4] +
            a[r + 4] * b[c * 4 + 1] +
            a[r + 8] * b[c * 4 + 2] +
            a[r + 12] * b[c * 4 + 3];
        }
      }
      return o;
    },
    translation(x, y, z) {
      return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
    },
    scaling(x, y, z) {
      return new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
    },
    rotationY(angle) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
    },
    perspective(fovY, aspect, near, far) {
      const f = 1 / Math.tan(fovY / 2);
      const nf = 1 / (near - far);
      return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0,
      ]);
    },
    lookAt(eye, target, up) {
      const z = normalize(sub(eye, target));
      const x = normalize(cross(up, z));
      const y = cross(z, x);
      return new Float32Array([
        x[0], y[0], z[0], 0,
        x[1], y[1], z[1], 0,
        x[2], y[2], z[2], 0,
        -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
      ]);
    },
    reflectY() {
      return new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    },
  };

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const normalize = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const reflectDirY = (v) => [v[0], -v[1], v[2]];

  function srgb(hex) {
    const r = ((hex >> 16) & 255) / 255;
    const g = ((hex >> 8) & 255) / 255;
    const b = (hex & 255) / 255;
    return [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];
  }

  // ---------------------------------------------------------------------------
  // GL helpers
  // ---------------------------------------------------------------------------
  function compileShader(type, source, label) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`${label} shader failed:\n${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }

  function createProgram(vsSource, fsSource, label) {
    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vsSource, label + " VS"));
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fsSource, label + " FS"));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`${label} program failed:\n${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  function uniform(program, name) {
    return gl.getUniformLocation(program, name);
  }

  function bindUniforms(program, names) {
    const map = {};
    for (const name of names) map[name] = uniform(program, name);
    return map;
  }

  // Cube mesh, flat normals, 24 vertices.
  function buildCube() {
    const positions = [];
    const normals = [];
    const indices = [];

    function face(origin, u, v, n) {
      const base = positions.length / 3;
      const corners = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      for (const [a, b] of corners) {
        positions.push(
          origin[0] + u[0] * a + v[0] * b,
          origin[1] + u[1] * a + v[1] * b,
          origin[2] + u[2] * a + v[2] * b
        );
        normals.push(n[0], n[1], n[2]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    face([-0.5, -0.5, 0.5], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    face([0.5, -0.5, -0.5], [-1, 0, 0], [0, 1, 0], [0, 0, -1]);
    face([0.5, -0.5, 0.5], [0, 0, -1], [0, 1, 0], [1, 0, 0]);
    face([-0.5, -0.5, -0.5], [0, 0, 1], [0, 1, 0], [-1, 0, 0]);
    face([-0.5, 0.5, 0.5], [1, 0, 0], [0, 0, -1], [0, 1, 0]);
    face([-0.5, -0.5, -0.5], [1, 0, 0], [0, 0, 1], [0, -1, 0]);

    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint16Array(indices),
    };
  }

  function createCubeGeometry() {
    const cube = buildCube();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, cube.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const normalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, cube.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cube.indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    return vao;
  }

  function createPlaneGeometry() {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -0.5, 0, 0.5,
        0.5, 0, 0.5,
        0.5, 0, -0.5,
        -0.5, 0, -0.5,
      ]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const normals = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normals);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array([0, 1, 2, 0, 2, 3]),
      gl.STATIC_DRAW
    );

    gl.bindVertexArray(null);
    return vao;
  }

  function createGlowQuad() {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array([0, 1, 2, 0, 2, 3]),
      gl.STATIC_DRAW
    );
    gl.bindVertexArray(null);
    return vao;
  }

  const emptyVAO = gl.createVertexArray();

  const hdrSupported = !!gl.getExtension("EXT_color_buffer_float");
  const COLOR_INTERNAL = hdrSupported ? gl.RGBA16F : gl.RGBA8;
  const COLOR_TYPE = hdrSupported ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

  function createRenderTarget(width, height, withDepth, mipmapped) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const levels = mipmapped
      ? Math.floor(Math.log2(Math.max(width, height))) + 1
      : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, COLOR_INTERNAL, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR
    );

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0
    );

    let depth = null;
    if (withDepth) {
      depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        depth
      );
    }

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Render target incomplete: 0x" + status.toString(16));
    }

    return { texture, framebuffer, depth, width, height, mipmapped, levels };
  }

  function createHDRTarget(width, height, withDepth) {
    return createRenderTarget(width, height, withDepth, false);
  }

  function deleteTarget(target) {
    if (!target) return;
    gl.deleteTexture(target.texture);
    gl.deleteFramebuffer(target.framebuffer);
    if (target.depth) gl.deleteRenderbuffer(target.depth);
  }

  // ---------------------------------------------------------------------------
  // Shaders
  // ---------------------------------------------------------------------------
  const fullscreenVS = `#version 300 es
precision highp float;
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const skyFS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uTanHalfFov;
uniform float uAspect;

void main() {
  vec2 ndc = vUV * 2.0 - 1.0;
  vec3 dir = normalize(
    uCamRight * (ndc.x * uTanHalfFov * uAspect) +
    uCamUp * (ndc.y * uTanHalfFov) +
    uCamForward
  );

  float h = max(dir.y, 0.0);
  vec3 sky = mix(uHorizonColor, uZenithColor, pow(h, 0.55));
  sky = mix(uGroundColor, sky, smoothstep(-0.08, 0.0, dir.y));

  float sd = max(dot(dir, normalize(uSunDir)), 0.0);
  vec3 sun = uSunColor * (
    pow(sd, 4.0) * 0.16 +
    pow(sd, 18.0) * 0.35 +
    smoothstep(0.9992, 0.9999, sd) * 2.5
  );

  float haze = exp(-h * 12.0);
  sky = mix(sky, uFogColor, haze * 0.72);
  sky += sun;
  outColor = vec4(sky, 1.0);
}`;

  const objectVS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;

uniform mat4 uViewProj;
uniform mat4 uModel;

out vec3 vWorldPos;
out vec3 vNormal;

void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorldPos = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uViewProj * world;
}`;

  const objectFS = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vNormal;
out vec4 outColor;

uniform vec3 uColor;
uniform vec3 uEmissive;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform vec3 uCamPos;
uniform float uFogDensity;

void main() {
  vec3 n = normalize(vNormal);
  float ndl = max(dot(n, normalize(uSunDir)), 0.0);
  vec3 color = uColor * (uAmbient + uSunColor * ndl);
  color += uEmissive;

  float dist = distance(vWorldPos, uCamPos);
  float fog = 1.0 - exp2(-pow(dist * uFogDensity, 2.0));
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));
  outColor = vec4(color, 1.0);
}`;

  const glowVS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aQuad;

uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uSize;

out vec2 vUV;

void main() {
  vec3 world = uCenter + (uCamRight * aQuad.x + uCamUp * aQuad.y) * uSize;
  vUV = aQuad;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

  const glowFS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform vec3 uColor;
uniform float uIntensity;
uniform vec3 uCamPos;
uniform vec3 uCenter;
uniform vec3 uFogColor;
uniform float uFogDensity;

void main() {
  float r = length(vUV);
  if (r > 1.0) discard;
  float falloff = exp(-r * r * 4.0) * (1.0 - smoothstep(0.65, 1.0, r));
  float dist = distance(uCenter, uCamPos);
  float fog = 1.0 - exp2(-pow(dist * uFogDensity, 2.0));
  float visibility = clamp(1.0 - fog, 0.0, 1.0);
  outColor = vec4(uColor * uIntensity * falloff * visibility, 1.0);
}`;

  const waterVS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;

uniform mat4 uViewProj;
uniform mat4 uModel;

out vec3 vWorldPos;

void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorldPos = world.xyz;
  gl_Position = uViewProj * world;
}`;

  const waterFS = `#version 300 es
precision highp float;
in vec3 vWorldPos;
out vec4 outColor;

uniform sampler2D uReflection;
uniform vec2 uResolution;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;

uniform vec3 uDeepColor;
uniform vec3 uScatterColor;
uniform float uScatterStrength;
uniform vec3 uReflectionTint;
uniform float uReflectionStrength;
uniform float uReflectionDistortion;
uniform float uReflectionBlur;
uniform float uFresnelPower;
uniform float uFresnelBias;

uniform float uWaveHeight;
uniform float uWaveScale;
uniform float uWaveSpeed;
uniform float uNormalStrength;
uniform vec2 uWind;

uniform vec3 uSpecularColor;
uniform float uSpecularIntensity;
uniform float uSparkleIntensity;
uniform float uSparklePower;

uniform vec3 uFogColor;
uniform float uFogDensity;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  return valueNoise(p) * 0.65 + valueNoise(p * 2.13 + 17.3) * 0.35;
}

vec2 warpPoint(vec2 p, float t) {
  vec2 warp = vec2(
    valueNoise(p * 0.12 + 3.1 + t * 0.012),
    valueNoise(p * 0.13 + 9.7 - t * 0.010)
  ) - 0.5;
  return p + warp * 0.7;
}

// Analytic directional wave.  h += amplitude * sin(dot(p, dir) * frequency + t * speed)
// and grad += dh/dp, which lets us build normals without finite differences.
void addWave(
  vec2 p, vec2 dir, float frequency, float amplitude, float speed, float t,
  inout float h, inout vec2 grad
) {
  float phase = dot(p, dir) * frequency + t * speed;
  h += sin(phase) * amplitude;
  grad += cos(phase) * amplitude * frequency * dir;
}

// Long swell plus the stretched wind-streak layer.  The coordinate warp keeps
// the sine interference from looking like a woven grid.
vec3 baseNormal(vec2 p, float t, float dist, float detail) {
  vec2 wind = normalize(uWind + vec2(1e-5, 1e-5));
  vec2 perp = vec2(-wind.y, wind.x);
  vec2 q = warpPoint(p, t) * uWaveScale;

  float h = 0.0;
  vec2 grad = vec2(0.0);
  addWave(q, wind, 0.55, 0.34, 0.55, t, h, grad);
  addWave(q, normalize(wind + perp * 0.18), 0.95, 0.22, 0.85, t, h, grad);
  addWave(q, normalize(wind - perp * 0.12), 1.75, 0.11, 1.15, t, h, grad);
  addWave(q, normalize(wind + perp * 0.45), 3.40, 0.045 * detail, 1.50, t, h, grad);
  addWave(q, normalize(wind - perp * 0.30), 6.00, 0.020 * detail, 1.90, t, h, grad);

  grad *= uWaveScale;

  // Wind streaks are stretched along the wind and compressed across it.
  vec2 suv = vec2(dot(p, wind) * 0.10, dot(p, perp) * 1.10 * uWaveScale);
  const float e = 0.16;
  float n0 = fbm(suv + vec2(t * 0.030, t * 0.008));
  float nx = fbm(suv + vec2(e, 0.0) + vec2(t * 0.030, t * 0.008));
  float nz = fbm(suv + vec2(0.0, e) + vec2(t * 0.030, t * 0.008));
  float streak = 0.22 * detail * uWaveHeight;
  grad += vec2((nx - n0) / e, (nz - n0) / e) * streak;
  h += (n0 - 0.5) * streak * 4.0;

  vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
  n.xz *= uNormalStrength;

  float flatten = clamp(dist / 260.0, 0.0, 1.0) * 0.60;
  return normalize(mix(n, vec3(0.0, 1.0, 0.0), flatten));
}

// Irregular capillary ripples, used for the sun glitter only.  Keeping them
// out of the reflection normal leaves the mirror image readable.
vec3 detailNormal(vec2 p, float t, float detail) {
  vec2 wind = normalize(uWind + vec2(1e-5, 1e-5));
  vec2 perp = vec2(-wind.y, wind.x);
  vec2 q = warpPoint(p, t) * uWaveScale;

  float h = 0.0;
  vec2 grad = vec2(0.0);
  addWave(q, normalize(wind + perp * 0.70), 10.00, 0.008, 2.40, t, h, grad);
  addWave(q, normalize(wind - perp * 0.05), 22.00, 0.014, 4.00, t, h, grad);
  addWave(q, normalize(wind + perp * 0.22), 35.00, 0.008, 5.00, t, h, grad);

  grad *= uWaveScale;

  vec2 fuv = vec2(dot(p, wind) * 3.0, dot(p, perp) * 8.0) * uWaveScale;
  const float e = 0.035;
  float n0 = valueNoise(fuv + t * 0.60) * 0.035 +
             valueNoise(fuv * 2.1 - t * 0.90 + 11.3) * 0.012;
  float nx = valueNoise(fuv + vec2(e, 0.0) + t * 0.60) * 0.035 +
             valueNoise(fuv * 2.1 + vec2(e * 2.1, 0.0) - t * 0.90 + 11.3) * 0.012;
  float nz = valueNoise(fuv + vec2(0.0, e) + t * 0.60) * 0.035 +
             valueNoise(fuv * 2.1 + vec2(0.0, e * 2.1) - t * 0.90 + 11.3) * 0.012;
  grad += vec2((nx - n0) / e, (nz - n0) / e) * uWaveHeight * detail;

  vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
  return n;
}

void main() {
  vec3 worldPos = vWorldPos;
  vec2 p = worldPos.xz;
  float t = uTime * uWaveSpeed;
  float dist = distance(uCamPos, worldPos);
  float detail = mix(0.35, 1.0, clamp(1.0 - dist / 120.0, 0.0, 1.0));
  // Fade sub-pixel ripple detail to keep the procedural normals from
  // shimmering or forming a moire grid in the near field.
  float footprint = max(length(dFdx(worldPos.xz)), length(dFdy(worldPos.xz)));
  detail *= clamp(1.0 - footprint * 6.0, 0.0, 1.0);

  vec3 n = baseNormal(p, t, dist, detail);
  vec3 nFine = detailNormal(p, t, detail);
  vec3 nSpec = normalize(vec3(n.xz * 1.4 + nFine.xz * 1.8, 1.0));

  vec3 v = normalize(uCamPos - worldPos);
  vec3 l = normalize(uSunDir);
  vec3 h = normalize(l + v);

  float ndotv = clamp(dot(n, v), 0.0, 1.0);
  float ndotl = clamp(dot(n, l), 0.0, 1.0);
  float ndoth = clamp(dot(nSpec, h), 0.0, 1.0);

  float fresnel = uFresnelBias +
    (1.0 - uFresnelBias) * pow(1.0 - ndotv, uFresnelPower);
  fresnel = clamp(fresnel * uReflectionStrength, 0.0, 1.0);

  vec2 screenUV = gl_FragCoord.xy / uResolution;
  vec2 reflNormal = n.xz * 0.75 + nFine.xz * 0.45;
  vec2 distortion = reflNormal * uReflectionDistortion *
    mix(0.65, 1.45, clamp(dist / 80.0, 0.0, 1.0));
  distortion.y *= 1.5;

  vec2 reflUV = clamp(screenUV + distortion, vec2(0.002), vec2(0.998));
  float lod = clamp(dist / 120.0, 0.0, 1.0) * uReflectionBlur;
  vec3 reflection = textureLod(uReflection, reflUV, lod).rgb * uReflectionTint;

  vec3 water = uDeepColor;
  vec3 scatter = uScatterColor * uScatterStrength;
  water = mix(water, scatter, clamp(ndotv * 0.85, 0.0, 1.0));
  water *= mix(0.70, 1.15, ndotl);

  vec3 color = mix(water, reflection, fresnel);

  float sparkleMask = smoothstep(
    0.30, 0.76,
    valueNoise(p * 2.2 + vec2(t * 0.10, -t * 0.07))
  );
  float broad = pow(ndoth, 42.0) * uSpecularIntensity;
  float sparkle = pow(ndoth, uSparklePower) * uSparkleIntensity * sparkleMask;
  float specular = (broad * 0.45 + sparkle) * ndotl *
    (0.30 + 0.70 * fresnel);
  color += uSunColor * uSpecularColor * specular;

  float sunAlign = pow(clamp(dot(v, l), 0.0, 1.0), 12.0);
  color += uSunColor * uSpecularColor * sunAlign * 0.035;

  float fog = 1.0 - exp2(-pow(dist * uFogDensity, 2.0));
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));

  outColor = vec4(color, 1.0);
}`;

  const brightFS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uScene;
uniform float uThreshold;
void main() {
  vec3 c = texture(uScene, vUV).rgb;
  float brightness = max(c.r, max(c.g, c.b));
  float weight = smoothstep(uThreshold, uThreshold + 0.55, brightness);
  outColor = vec4(c * weight, 1.0);
}`;

  const blurFS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTexture;
uniform vec2 uDirection;
void main() {
  vec3 sum = texture(uTexture, vUV).rgb * 0.2270270270;
  sum += texture(uTexture, vUV + uDirection * 1.3846153846).rgb * 0.3162162162;
  sum += texture(uTexture, vUV - uDirection * 1.3846153846).rgb * 0.3162162162;
  sum += texture(uTexture, vUV + uDirection * 3.2307692308).rgb * 0.0702702703;
  sum += texture(uTexture, vUV - uDirection * 3.2307692308).rgb * 0.0702702703;
  outColor = vec4(sum, 1.0);
}`;

  const finalFS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uExposure;

vec3 aces(vec3 x) {
  return clamp(
    (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14),
    0.0, 1.0
  );
}

void main() {
  vec3 color = texture(uScene, vUV).rgb;
  color += texture(uBloom, vUV).rgb * uBloomStrength;
  color *= uExposure;
  color = aces(color);
  color = pow(color, vec3(1.0 / 2.2));

  vec2 q = vUV - 0.5;
  float vignette = 1.0 - 0.10 * dot(q, q) * 2.0;
  outColor = vec4(color * vignette, 1.0);
}`;

  const skyProgram = createProgram(fullscreenVS, skyFS, "Sky");
  const objectProgram = createProgram(objectVS, objectFS, "Object");
  const glowProgram = createProgram(glowVS, glowFS, "Glow");
  const waterProgram = createProgram(waterVS, waterFS, "Water");
  const brightProgram = createProgram(fullscreenVS, brightFS, "Bright");
  const blurProgram = createProgram(fullscreenVS, blurFS, "Blur");
  const finalProgram = createProgram(fullscreenVS, finalFS, "Final");

  const skyU = bindUniforms(skyProgram, [
    "uCamRight", "uCamUp", "uCamForward", "uSunDir", "uSunColor",
    "uHorizonColor", "uZenithColor", "uGroundColor", "uFogColor",
    "uTanHalfFov", "uAspect",
  ]);
  const objectU = bindUniforms(objectProgram, [
    "uViewProj", "uModel", "uColor", "uEmissive", "uSunDir", "uSunColor",
    "uAmbient", "uFogColor", "uCamPos", "uFogDensity",
  ]);
  const glowU = bindUniforms(glowProgram, [
    "uViewProj", "uCenter", "uCamRight", "uCamUp", "uSize", "uColor",
    "uIntensity", "uCamPos", "uFogColor", "uFogDensity",
  ]);
  const waterU = bindUniforms(waterProgram, [
    "uViewProj", "uModel", "uReflection", "uResolution", "uCamPos", "uTime",
    "uSunDir", "uSunColor", "uDeepColor", "uScatterColor", "uScatterStrength",
    "uReflectionTint", "uReflectionStrength", "uReflectionDistortion",
    "uReflectionBlur", "uFresnelPower", "uFresnelBias", "uWaveHeight",
    "uWaveScale", "uWaveSpeed", "uNormalStrength", "uWind", "uSpecularColor",
    "uSpecularIntensity", "uSparkleIntensity", "uSparklePower", "uFogColor",
    "uFogDensity",
  ]);
  const brightU = bindUniforms(brightProgram, ["uScene", "uThreshold"]);
  const blurU = bindUniforms(blurProgram, ["uTexture", "uDirection"]);
  const finalU = bindUniforms(finalProgram, [
    "uScene", "uBloom", "uBloomStrength", "uExposure",
  ]);

  // ---------------------------------------------------------------------------
  // Scene
  // ---------------------------------------------------------------------------
  const cubeVAO = createCubeGeometry();
  const planeVAO = createPlaneGeometry();
  const glowVAO = createGlowQuad();

  const COL = {
    concrete: srgb(0x858077),
    warm: srgb(0x9a9085),
    pink: srgb(0xb09699),
    dark: srgb(0x2e2e29),
    green: srgb(0x44503a),
    waterFlat: srgb(0x151c18),
  };

  const WARM_WINDOW = [2.1, 0.85, 0.22];
  const COOL_WINDOW = [1.2, 1.1, 0.85];
  const LAMP = [5.5, 2.4, 0.6];

  const scene = [];
  const glows = [];

  function box(x, y, z, sx, sy, sz, color, emissive, rotY) {
    const model = M4.multiply(
      M4.translation(x, y, z),
      M4.multiply(
        M4.rotationY(rotY || 0),
        M4.scaling(sx, sy, sz)
      )
    );
    scene.push({
      model,
      color: color || COL.concrete,
      emissive: emissive || [0, 0, 0],
    });
  }

  function lamp(x, z, baseY) {
    box(x, baseY + 3.1, z, 0.22, 6.2, 0.22, COL.dark);
    box(x, baseY + 6.35, z, 0.68, 0.62, 0.68, [0.05, 0.04, 0.03], LAMP);
    glows.push({ center: [x, baseY + 6.35, z], color: [1.0, 0.38, 0.08], size: 2.6, intensity: 0.50 });
  }

  function windows(x, zStart, floors, rows, stepZ, warm, faceSign) {
    for (let row = 0; row < rows; row++) {
      for (let floor = 0; floor < floors; floor++) {
        const emissive = warm ? WARM_WINDOW : COOL_WINDOW;
        box(
          x,
          4.2 + floor * 4.4,
          zStart - row * stepZ,
          faceSign * 0.10,
          1.0,
          1.3,
          [0.08, 0.07, 0.06],
          emissive
        );
      }
    }
  }

  // Quays and waterfront walls.
  box(-12, 1.35, -35, 2, 2.7, 130, COL.concrete);
  box(12, 1.35, -35, 2, 2.7, 130, COL.concrete);
  box(-15.5, 2.85, -35, 9, 0.3, 130, COL.concrete);
  box(15.5, 2.85, -35, 9, 0.3, 130, COL.concrete);

  // Left bank, close to the canal like the reference.
  box(-22, 10, -16, 20, 20, 22, COL.warm);
  box(-29, 14, -52, 26, 28, 28, COL.concrete);
  box(-20, 8, -84, 16, 16, 20, COL.dark);
  windows(-11.9, -8, 4, 4, 4.0, true, 1);
  windows(-15.9, -44, 5, 3, 5.2, false, 1);

  // Right bank.
  box(22, 12, -24, 20, 24, 24, COL.pink);
  box(29, 9, -58, 28, 18, 26, COL.concrete);
  box(21, 16, -88, 18, 32, 22, COL.warm);
  windows(11.9, -16, 5, 4, 4.2, true, -1);
  windows(14.9, -50, 4, 3, 5.6, false, -1);

  // Vertical piers along the quay; these give the reference its strong
  // vertical reflection rhythm.
  for (const z of [-2, -14, -26, -38, -56]) {
    box(-10.6, 2.2, z, 1.5, 4.4, 1.5, COL.concrete);
    box(10.6, 2.2, z, 1.5, 4.4, 1.5, COL.concrete);
  }

  // Tower and antenna.
  box(-8, 19, -102, 15, 38, 15, COL.warm);
  box(-8, 38.5, -102, 12, 2, 12, COL.concrete);
  box(-8, 45, -102, 0.24, 11, 0.24, COL.dark);
  windows(-0.4, -94, 5, 2, 5.5, true, -1);

  // Bridge.
  box(0, 8.7, -36, 100, 2.0, 9, COL.concrete);
  box(0, 10.5, -31.6, 100, 1.1, 0.35, COL.dark);
  box(0, 10.5, -40.4, 100, 1.1, 0.35, COL.dark);
  for (const x of [-9, -24, 9, 24]) {
    box(x, 3.9, -36, 2.2, 7.8, 6, COL.concrete);
  }
  for (const x of [-35, -15, 15, 35]) {
    lamp(x, -36, 8.0);
  }

  // Far bridge silhouette.
  box(0, 7, -140, 110, 1.2, 7, COL.concrete);

  // Bank lamps.
  for (const z of [-6, -28, -50, -72]) {
    lamp(-11.5, z, 2.85);
    lamp(11.5, z, 2.85);
  }

  // Blocky tree, like the reference's left-bank tree.
  box(-16.2, 8, -8, 1.1, 12, 1.1, COL.dark);
  box(-16.2, 15.2, -8, 7, 2.6, 7, COL.green);
  box(-16.2, 17.4, -9, 4.6, 2.0, 4.6, COL.green);

  // ---------------------------------------------------------------------------
  // Camera / lighting constants
  // ---------------------------------------------------------------------------
  const eye = [0, 1.78, 13];
  const target = [0, 2.05, -60];
  const up = [0, 1, 0];
  const fov = (58 * Math.PI) / 180;
  const aspect = W / H;
  const near = 0.1;
  const far = 500;

  const view = M4.lookAt(eye, target, up);
  const projection = M4.perspective(fov, aspect, near, far);
  const viewProj = M4.multiply(projection, view);

  const reflection = M4.reflectY();
  const reflectionView = M4.multiply(view, reflection);
  const reflectionViewProj = M4.multiply(projection, reflectionView);

  const forward = normalize(sub(target, eye));
  const right = normalize(cross(forward, up));
  const cameraUp = normalize(cross(right, forward));
  const tanHalfFov = Math.tan(fov / 2);

  const sunDir = normalize([0.12, 0.16, -1.0]);
  const lightColor = [1.0 * 1.10, 0.86 * 1.10, 0.68 * 1.10];
  const ambient = [0.36, 0.35, 0.33];
  const fogColor = srgb(0xb6ac9b);
  const fogDensity = 0.0160;

  // ---------------------------------------------------------------------------
  // Render targets
  // ---------------------------------------------------------------------------
  const reflectionTarget = createRenderTarget(REFL_W, REFL_H, true, true);
  const hdrTarget = createHDRTarget(W, H, true);
  const bloomA = createHDRTarget(Math.round(W / 2), Math.round(H / 2), false);
  const bloomB = createHDRTarget(Math.round(W / 2), Math.round(H / 2), false);

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  function setSkyUniforms(programUniforms, reflectionPass) {
    const r = reflectionPass ? reflectDirY(right) : right;
    const u = reflectionPass ? reflectDirY(cameraUp) : cameraUp;
    const f = reflectionPass ? reflectDirY(forward) : forward;
    gl.useProgram(skyProgram);
    gl.uniform3fv(programUniforms.uCamRight, r);
    gl.uniform3fv(programUniforms.uCamUp, u);
    gl.uniform3fv(programUniforms.uCamForward, f);
    gl.uniform3fv(programUniforms.uSunDir, sunDir);
    gl.uniform3fv(programUniforms.uSunColor, [1.35, 1.12, 0.82]);
    gl.uniform3fv(programUniforms.uHorizonColor, srgb(0xbdb3a1));
    gl.uniform3fv(programUniforms.uZenithColor, srgb(0x8f918c));
    gl.uniform3fv(programUniforms.uGroundColor, srgb(0x9f9789));
    gl.uniform3fv(programUniforms.uFogColor, fogColor);
    gl.uniform1f(programUniforms.uTanHalfFov, tanHalfFov);
    gl.uniform1f(programUniforms.uAspect, aspect);
  }

  function drawSky(reflectionPass) {
    setSkyUniforms(skyU, reflectionPass);
    gl.bindVertexArray(emptyVAO);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  function drawObjects(program, uniforms, viewProjMatrix) {
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uViewProj, false, viewProjMatrix);
    gl.uniform3fv(uniforms.uSunDir, sunDir);
    gl.uniform3fv(uniforms.uSunColor, lightColor);
    gl.uniform3fv(uniforms.uAmbient, ambient);
    gl.uniform3fv(uniforms.uFogColor, fogColor);
    gl.uniform3fv(uniforms.uCamPos, eye);
    gl.uniform1f(uniforms.uFogDensity, fogDensity);

    gl.bindVertexArray(cubeVAO);
    for (const item of scene) {
      gl.uniformMatrix4fv(uniforms.uModel, false, item.model);
      gl.uniform3fv(uniforms.uColor, item.color);
      gl.uniform3fv(uniforms.uEmissive, item.emissive);
      gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
    }
  }

  function drawGlows(reflectionPass, viewProjMatrix) {
    gl.useProgram(glowProgram);
    gl.uniformMatrix4fv(glowU.uViewProj, false, viewProjMatrix);
    gl.uniform3fv(glowU.uCamRight, reflectionPass ? reflectDirY(right) : right);
    gl.uniform3fv(glowU.uCamUp, reflectionPass ? reflectDirY(cameraUp) : cameraUp);
    gl.uniform3fv(glowU.uCamPos, eye);
    gl.uniform3fv(glowU.uFogColor, fogColor);
    gl.uniform1f(glowU.uFogDensity, fogDensity);

    gl.bindVertexArray(glowVAO);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    for (const glow of glows) {
      gl.uniform3fv(glowU.uCenter, glow.center);
      gl.uniform3fv(glowU.uColor, glow.color);
      gl.uniform1f(glowU.uSize, glow.size);
      gl.uniform1f(glowU.uIntensity, glow.intensity);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  function drawWater(viewProjMatrix, time, useShader) {
    gl.bindVertexArray(planeVAO);

    if (!useShader) {
      gl.useProgram(objectProgram);
      gl.uniformMatrix4fv(objectU.uViewProj, false, viewProjMatrix);
      gl.uniformMatrix4fv(
        objectU.uModel,
        false,
        M4.multiply(M4.translation(0, 0, 0), M4.scaling(600, 1, 600))
      );
      gl.uniform3fv(objectU.uColor, COL.waterFlat);
      gl.uniform3fv(objectU.uEmissive, [0, 0, 0]);
      gl.uniform3fv(objectU.uSunDir, sunDir);
      gl.uniform3fv(objectU.uSunColor, lightColor);
      gl.uniform3fv(objectU.uAmbient, ambient);
      gl.uniform3fv(objectU.uFogColor, fogColor);
      gl.uniform3fv(objectU.uCamPos, eye);
      gl.uniform1f(objectU.uFogDensity, fogDensity);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      return;
    }

    gl.useProgram(waterProgram);
    gl.uniformMatrix4fv(waterU.uViewProj, false, viewProjMatrix);
    gl.uniformMatrix4fv(
      waterU.uModel,
      false,
      M4.multiply(M4.translation(0, 0, 0), M4.scaling(600, 1, 600))
    );
    gl.uniform3fv(waterU.uCamPos, eye);
    gl.uniform2f(waterU.uResolution, W, H);
    gl.uniform1f(waterU.uTime, time);
    gl.uniform3fv(waterU.uSunDir, sunDir);
    gl.uniform3fv(waterU.uSunColor, lightColor);

    gl.uniform3fv(waterU.uDeepColor, srgb(0x1b2620));
    gl.uniform3fv(waterU.uScatterColor, srgb(0x2e3a2e));
    gl.uniform1f(waterU.uScatterStrength, 0.60);
    gl.uniform3fv(waterU.uReflectionTint, srgb(0xd2cdc0));
    gl.uniform1f(waterU.uReflectionStrength, 1.0);
    gl.uniform1f(waterU.uReflectionDistortion, 0.20);
    gl.uniform1f(waterU.uReflectionBlur, 2.4);
    gl.uniform1f(waterU.uFresnelPower, 5.0);
    gl.uniform1f(waterU.uFresnelBias, 0.040);

    gl.uniform1f(waterU.uWaveHeight, 0.16);
    gl.uniform1f(waterU.uWaveScale, 1.0);
    gl.uniform1f(waterU.uWaveSpeed, 0.80);
    gl.uniform1f(waterU.uNormalStrength, 0.90);
    gl.uniform2f(waterU.uWind, 0.85, 0.5);

    gl.uniform3fv(waterU.uSpecularColor, [1.0, 0.9, 0.72]);
    gl.uniform1f(waterU.uSpecularIntensity, 1.2);
    gl.uniform1f(waterU.uSparkleIntensity, 2.6);
    gl.uniform1f(waterU.uSparklePower, 120.0);

    gl.uniform3fv(waterU.uFogColor, fogColor);
    gl.uniform1f(waterU.uFogDensity, fogDensity);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, reflectionTarget.texture);
    gl.uniform1i(waterU.uReflection, 0);

    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  function renderReflection(time) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, reflectionTarget.framebuffer);
    gl.viewport(0, 0, REFL_W, REFL_H);
    gl.clearColor(fogColor[0], fogColor[1], fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    drawSky(true);
    drawObjects(objectProgram, objectU, reflectionViewProj);
    drawGlows(true, reflectionViewProj);

    // Generate the mips only after the reflection framebuffer is unbound;
    // generating while the texture is still attached is feedback.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, reflectionTarget.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  function renderMain(time) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdrTarget.framebuffer);
    gl.viewport(0, 0, W, H);
    gl.clearColor(fogColor[0], fogColor[1], fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    drawSky(false);
    drawObjects(objectProgram, objectU, viewProj);
    drawGlows(false, viewProj);
    drawWater(viewProj, time, mode === "after");
  }

  function renderBloom() {
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.framebuffer);
    gl.viewport(0, 0, bloomA.width, bloomA.height);
    gl.useProgram(brightProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdrTarget.texture);
    gl.uniform1i(brightU.uScene, 0);
    gl.uniform1f(brightU.uThreshold, 1.0);
    gl.bindVertexArray(emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Horizontal blur.
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.framebuffer);
    gl.useProgram(blurProgram);
    gl.bindTexture(gl.TEXTURE_2D, bloomA.texture);
    gl.uniform1i(blurU.uTexture, 0);
    gl.uniform2f(blurU.uDirection, 1 / bloomA.width, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Vertical blur.
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, bloomB.texture);
    gl.uniform2f(blurU.uDirection, 0, 1 / bloomB.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function renderFinal() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(finalProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdrTarget.texture);
    gl.uniform1i(finalU.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomA.texture);
    gl.uniform1i(finalU.uBloom, 1);
    gl.uniform1f(finalU.uBloomStrength, 0.55);
    gl.uniform1f(finalU.uExposure, 0.88);
    gl.bindVertexArray(emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  function render(time) {
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true);

    renderReflection(time);
    renderMain(time);
    renderBloom();
    renderFinal();
  }

  // ---------------------------------------------------------------------------
  // UI / loop
  // ---------------------------------------------------------------------------
  const beforeButton = document.getElementById("before");
  const afterButton = document.getElementById("after");

  function updateButtons() {
    beforeButton.setAttribute("aria-pressed", mode === "before" ? "true" : "false");
    afterButton.setAttribute("aria-pressed", mode === "after" ? "true" : "false");
  }

  beforeButton.addEventListener("click", () => {
    mode = "before";
    updateButtons();
  });
  afterButton.addEventListener("click", () => {
    mode = "after";
    updateButtons();
  });
  updateButtons();

  const start = performance.now();
  const fixedTime = 12.0;

  if (CAPTURE) {
    render(fixedTime);
    requestAnimationFrame(() => {
      window.__previewReady = true;
      document.title = "DSH Water · ready";
    });
  } else {
    function frame(now) {
      render(fixedTime + (now - start) / 1000);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
})();
