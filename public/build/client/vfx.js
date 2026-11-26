import * as THREE from 'three';
import { CHAMPION_LIST, getChampionConfig } from '../shared/champions/index.js';
import { championRigs, getCachedProjectileTemplate, getCachedZoneMeshTemplate } from './champion.js';
import { camera, renderer, scene, textureLoader, viewportHeight, vfxTextures } from './scene.js';
import { state } from './state.js';
const activeProjectileMeshes = new Map();
const activeGroundZoneMeshes = new Map();
const transientVfx = [];
const seenProjIds = new Set();
const seenZoneIds = new Set();
// Cached champion VFX textures keyed by URL
const champTextureCache = new Map();
// Retain prewarmed materials so Three.js WebGLPrograms refcounts stay > 0 permanently
const prewarmedVfxMats = [];
/**
 * Create a single-pass transparent MeshBasicMaterial so DoubleSide VFX quads
 * never trigger Three.js two-pass BackSide/FrontSide shader splits at runtime.
 */
function createVfxBasicMat(params) {
    return new THREE.MeshBasicMaterial({
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        forceSinglePass: true,
        ...params
    });
}
// Single pooled THREE.Points particle system for all rock debris (1 draw call, zero allocations)
const MAX_DEBRIS = 96;
const debrisPositions = new Float32Array(MAX_DEBRIS * 3);
const debrisVelocities = new Float32Array(MAX_DEBRIS * 3);
const debrisAges = new Float32Array(MAX_DEBRIS);
const debrisDurations = new Float32Array(MAX_DEBRIS);
let debrisActiveCount = 0;
for (let i = 0; i < MAX_DEBRIS; i++) {
    debrisPositions[i * 3 + 1] = -9999;
}
const debrisGeo = new THREE.BufferGeometry();
const debrisPosAttr = new THREE.BufferAttribute(debrisPositions, 3);
debrisPosAttr.setUsage(THREE.DynamicDrawUsage);
debrisGeo.setAttribute('position', debrisPosAttr);
const debrisMat = new THREE.PointsMaterial({
    color: 0xc2b0d8,
    size: 26,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false
});
const debrisPoints = new THREE.Points(debrisGeo, debrisMat);
debrisPoints.frustumCulled = false;
debrisPoints.visible = false;
scene.add(debrisPoints);
// Single pooled GPU Points system for all sparkles & ghost orbs (1 draw call, zero runtime allocations)
const MAX_SPARKLES = 192;
const sparklePositions = new Float32Array(MAX_SPARKLES * 3);
const sparkleVelocities = new Float32Array(MAX_SPARKLES * 3);
const sparkleColors = new Float32Array(MAX_SPARKLES * 3);
const sparkleSizes = new Float32Array(MAX_SPARKLES);
const sparkleBaseSizes = new Float32Array(MAX_SPARKLES);
const sparkleAlphas = new Float32Array(MAX_SPARKLES);
const sparkleAges = new Float32Array(MAX_SPARKLES);
const sparkleDurations = new Float32Array(MAX_SPARKLES);
const sparkleKinds = new Uint8Array(MAX_SPARKLES); // 0 = sparkle, 1 = ghost orb
let sparkleActiveCount = 0;
for (let i = 0; i < MAX_SPARKLES; i++) {
    sparklePositions[i * 3 + 1] = -9999;
}
const sparkleGeo = new THREE.BufferGeometry();
const sparklePosAttr = new THREE.BufferAttribute(sparklePositions, 3);
sparklePosAttr.setUsage(THREE.DynamicDrawUsage);
const sparkleColorAttr = new THREE.BufferAttribute(sparkleColors, 3);
sparkleColorAttr.setUsage(THREE.DynamicDrawUsage);
const sparkleSizeAttr = new THREE.BufferAttribute(sparkleSizes, 1);
sparkleSizeAttr.setUsage(THREE.DynamicDrawUsage);
const sparkleAlphaAttr = new THREE.BufferAttribute(sparkleAlphas, 1);
sparkleAlphaAttr.setUsage(THREE.DynamicDrawUsage);
sparkleGeo.setAttribute('position', sparklePosAttr);
sparkleGeo.setAttribute('aColor', sparkleColorAttr);
sparkleGeo.setAttribute('aSize', sparkleSizeAttr);
sparkleGeo.setAttribute('aAlpha', sparkleAlphaAttr);
const _tempColor = new THREE.Color();
const sparkleUniforms = {
    uScale: {
        value: (viewportHeight * renderer.getPixelRatio() * 0.5) /
            Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
    },
    uMap: { value: null },
    uHasMap: { value: 0 }
};
export function updateVfxViewportScale(height, pixelRatio) {
    sparkleUniforms.uScale.value =
        (height * pixelRatio * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
}
const sparkleShaderMat = new THREE.ShaderMaterial({
    uniforms: sparkleUniforms,
    vertexShader: `
    attribute vec3 aColor;
    attribute float aSize;
    attribute float aAlpha;
    uniform float uScale;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vColor = aColor;
      vAlpha = aAlpha;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uScale / max(1.0, -mvPosition.z);
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
    fragmentShader: `
    uniform sampler2D uMap;
    uniform float uHasMap;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      if (vAlpha <= 0.005) discard;
      vec2 uv = gl_PointCoord;
      float dist = length(uv - vec2(0.5));
      if (dist > 0.5) discard;
      vec4 tex = uHasMap > 0.5
        ? texture2D(uMap, vec2(uv.x, 1.0 - uv.y))
        : vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(0.12, 0.5, dist));
      float alpha = tex.a * vAlpha;
      if (alpha <= 0.005) discard;
      gl_FragColor = vec4(tex.rgb * vColor, alpha);
    }
  `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
});
const sparklePoints = new THREE.Points(sparkleGeo, sparkleShaderMat);
sparklePoints.frustumCulled = false;
sparklePoints.visible = false;
scene.add(sparklePoints);
function extractTopLeftShardTexture(sourceTex) {
    const img = sourceTex.image;
    if (!img || !img.width || !img.height)
        return null;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return null;
    ctx.drawImage(img, 0, 0, img.width / 2, img.height / 2, 0, 0, 64, 64);
    const cropped = new THREE.CanvasTexture(canvas);
    cropped.colorSpace = THREE.SRGBColorSpace;
    return cropped;
}
export async function loadChampionVfxTextures() {
    const urls = new Set();
    for (const champ of CHAMPION_LIST) {
        if (champ.q.archetype === 'delayed_ground_aoe') {
            const zv = champ.q.zoneVisual;
            if (zv.crackTextureUrl)
                urls.add(zv.crackTextureUrl);
            if (zv.indicatorTextureUrl)
                urls.add(zv.indicatorTextureUrl);
            if (zv.smokeTextureUrl)
                urls.add(zv.smokeTextureUrl);
            if (zv.auraTextureUrl)
                urls.add(zv.auraTextureUrl);
            if (zv.rockTextureUrl)
                urls.add(zv.rockTextureUrl);
        }
    }
    await Promise.all(Array.from(urls).map(async (url) => {
        try {
            const tex = await textureLoader.loadAsync(url);
            tex.colorSpace = THREE.SRGBColorSpace;
            champTextureCache.set(url, tex);
            if (url.includes('rockshards') && !debrisMat.map) {
                const singleTile = extractTopLeftShardTexture(tex);
                if (singleTile) {
                    debrisMat.map = singleTile;
                    debrisMat.needsUpdate = true;
                }
            }
        }
        catch { }
    }));
}
// Shared reusable geometries (never disposed per-effect, zero runtime allocations)
const sharedUnitRingGeo = new THREE.RingGeometry(0.7, 0.93, 28);
sharedUnitRingGeo.rotateX(-Math.PI / 2);
const sharedZoneOuterRingGeo = new THREE.RingGeometry(0.93, 1.0, 56);
sharedZoneOuterRingGeo.rotateX(-Math.PI / 2);
const sharedZoneRimCylinderGeo = new THREE.CylinderGeometry(1, 1, 16, 48, 1, true);
const sharedZoneFillGeo = new THREE.CircleGeometry(1, 48);
sharedZoneFillGeo.rotateX(-Math.PI / 2);
const sharedZoneDecalGeo = new THREE.PlaneGeometry(2.15, 2.15);
sharedZoneDecalGeo.rotateX(-Math.PI / 2);
const sharedSmokeRayGeo = new THREE.PlaneGeometry(0.85, 1.65);
sharedSmokeRayGeo.translate(0, 0.825, 0);
const sharedFallbackSpikeGeo = new THREE.ConeGeometry(16, 120, 5);
sharedFallbackSpikeGeo.translate(0, 60, 0);
const sharedProjFallbackGeo = new THREE.BoxGeometry(22, 55, 140);
const sharedOrbGeo = new THREE.SphereGeometry(1, 14, 12);
const sharedRingBurstGeo = new THREE.RingGeometry(1, 1.35, 36);
sharedRingBurstGeo.rotateX(-Math.PI / 2);
const sharedSkybeamGeo = new THREE.PlaneGeometry(1, 1);
sharedSkybeamGeo.translate(0, 0.5, 0);
const sharedFlashHaloGeo = new THREE.PlaneGeometry(185, 185);
sharedFlashHaloGeo.rotateX(-Math.PI / 2);
const sharedFlashStarGeo = new THREE.PlaneGeometry(155, 155);
sharedFlashStarGeo.rotateX(-Math.PI / 2);
const sharedHealBurst1Geo = new THREE.PlaneGeometry(230, 230);
sharedHealBurst1Geo.rotateX(-Math.PI / 2);
const sharedHealBurst2Geo = new THREE.PlaneGeometry(210, 210);
sharedHealBurst2Geo.rotateX(-Math.PI / 2);
sharedHealBurst2Geo.rotateY(Math.PI / 4);
const sharedHealBoltGeo = new THREE.CylinderGeometry(88, 64, 95, 28, 1, true);
const sharedGhostCylGeo = new THREE.CylinderGeometry(82, 54, 125, 24, 1, true);
const sharedGhostRibbonGeo = new THREE.PlaneGeometry(92, 42);
export function syncProjectiles(dt) {
    seenProjIds.clear();
    for (const proj of state.serverProjectiles) {
        seenProjIds.add(proj.id);
        let entry = activeProjectileMeshes.get(proj.id);
        if (!entry) {
            const champ = getChampionConfig(proj.championId);
            const meshGroup = new THREE.Group();
            const materials = [];
            let spinner;
            let spinAxis = 'x';
            let spinSpeed = 24;
            const qCfg = champ.q;
            if (qCfg.archetype === 'linear_projectile') {
                const vis = qCfg.projectileVisual;
                if (vis.kind === 'obj_model') {
                    const tpl = getCachedProjectileTemplate(proj.championId);
                    if (tpl) {
                        spinner = tpl.clone();
                    }
                    else {
                        const fallbackMat = new THREE.MeshStandardMaterial({ color: 0xd0e8ff, metalness: 0.8 });
                        materials.push(fallbackMat);
                        spinner = new THREE.Mesh(sharedProjFallbackGeo, fallbackMat);
                    }
                    spinAxis = vis.spinAxis;
                    spinSpeed = vis.spinSpeed;
                }
                else {
                    const orbMat = new THREE.MeshStandardMaterial({
                        color: vis.coreColorHex,
                        emissive: new THREE.Color(vis.glowColorHex),
                        emissiveIntensity: 1.2,
                        roughness: 0.2
                    });
                    materials.push(orbMat);
                    const orbMesh = new THREE.Mesh(sharedOrbGeo, orbMat);
                    orbMesh.scale.setScalar(vis.radius * 0.55);
                    spinner = orbMesh;
                    spinAxis = 'y';
                    spinSpeed = 10;
                }
            }
            else {
                const fallbackMat = new THREE.MeshStandardMaterial({ color: 0xd0e8ff, metalness: 0.8 });
                materials.push(fallbackMat);
                spinner = new THREE.Mesh(sharedProjFallbackGeo, fallbackMat);
            }
            meshGroup.add(spinner);
            const ringMat = createVfxBasicMat({
                color: proj.ownerSlot === state.mySlot ? 0x26a9ff : 0xff4254,
                opacity: 0.55
            });
            materials.push(ringMat);
            const groundRing = new THREE.Mesh(sharedUnitRingGeo, ringMat);
            groundRing.scale.setScalar(proj.radius);
            groundRing.position.y = -62;
            meshGroup.add(groundRing);
            meshGroup.position.set(proj.x, 65, proj.z);
            meshGroup.rotation.y = Math.atan2(proj.dirX, proj.dirZ);
            scene.add(meshGroup);
            entry = { meshGroup, spinner, spinAxis, spinSpeed, materials };
            activeProjectileMeshes.set(proj.id, entry);
        }
        else {
            entry.meshGroup.position.x += proj.dirX * proj.speed * dt;
            entry.meshGroup.position.z += proj.dirZ * proj.speed * dt;
            const corr = Math.min(1, dt * 18);
            entry.meshGroup.position.x += (proj.x - entry.meshGroup.position.x) * corr;
            entry.meshGroup.position.z += (proj.z - entry.meshGroup.position.z) * corr;
            entry.meshGroup.rotation.y = Math.atan2(proj.dirX, proj.dirZ);
        }
        entry.spinner.rotation[entry.spinAxis] += dt * entry.spinSpeed;
    }
    for (const [id, entry] of activeProjectileMeshes.entries()) {
        if (!seenProjIds.has(id)) {
            scene.remove(entry.meshGroup);
            for (const m of entry.materials)
                m.dispose();
            activeProjectileMeshes.delete(id);
        }
    }
}
export function spawnCastAuraVfx(championId, x, z) {
    const champ = getChampionConfig(championId);
    if (champ.q.archetype !== 'delayed_ground_aoe')
        return;
    const auraUrl = champ.q.zoneVisual.auraTextureUrl;
    const auraTex = auraUrl ? champTextureCache.get(auraUrl) : undefined;
    if (!auraTex) {
        spawnRingBurstVfx(x, z, champ.accentHex, 30, 120, 0.3);
        return;
    }
    const mat = createVfxBasicMat({
        map: auraTex,
        color: champ.q.zoneVisual.eruptColorHex,
        opacity: 0.85,
        blending: THREE.AdditiveBlending
    });
    const mesh = new THREE.Mesh(sharedZoneDecalGeo, mat);
    mesh.position.set(x, 4, z);
    mesh.scale.setScalar(55);
    scene.add(mesh);
    transientVfx.push({
        mesh,
        age: 0,
        duration: 0.36,
        update() {
            const t = this.age / this.duration;
            mesh.scale.setScalar(55 + t * 48);
            mat.opacity = 0.85 * (1 - t);
        },
        onDispose() {
            mat.dispose();
        }
    });
}
function spawnRockDebrisParticle(x, y, z, vx, vy, vz, _size, duration) {
    for (let i = 0; i < MAX_DEBRIS; i++) {
        if (debrisDurations[i] <= 0) {
            const idx = i * 3;
            debrisPositions[idx] = x;
            debrisPositions[idx + 1] = y;
            debrisPositions[idx + 2] = z;
            debrisVelocities[idx] = vx;
            debrisVelocities[idx + 1] = vy;
            debrisVelocities[idx + 2] = vz;
            debrisAges[i] = 0;
            debrisDurations[i] = duration;
            debrisActiveCount += 1;
            debrisPoints.visible = true;
            debrisPosAttr.needsUpdate = true;
            return;
        }
    }
}
function updateRockDebrisPool(dt) {
    if (debrisActiveCount === 0)
        return;
    let active = 0;
    for (let i = 0; i < MAX_DEBRIS; i++) {
        const dur = debrisDurations[i];
        if (dur <= 0)
            continue;
        debrisAges[i] += dt;
        const idx = i * 3;
        if (debrisAges[i] >= dur) {
            debrisDurations[i] = 0;
            debrisPositions[idx + 1] = -9999;
            continue;
        }
        active += 1;
        debrisVelocities[idx + 1] -= 420 * dt;
        debrisPositions[idx] += debrisVelocities[idx] * dt;
        debrisPositions[idx + 1] = Math.max(4, debrisPositions[idx + 1] + debrisVelocities[idx + 1] * dt);
        debrisPositions[idx + 2] += debrisVelocities[idx + 2] * dt;
    }
    debrisActiveCount = active;
    debrisPosAttr.needsUpdate = true;
    if (active === 0) {
        debrisPoints.visible = false;
    }
}
export function syncGroundZones(dt) {
    seenZoneIds.clear();
    for (const zone of state.serverGroundZones) {
        seenZoneIds.add(zone.id);
        let entry = activeGroundZoneMeshes.get(zone.id);
        const isAlly = zone.ownerSlot === state.mySlot;
        const champ = getChampionConfig(zone.championId);
        const zv = champ.q.archetype === 'delayed_ground_aoe' ? champ.q.zoneVisual : null;
        if (!entry) {
            const group = new THREE.Group();
            group.position.set(zone.x, 2.5, zone.z);
            const materials = [];
            const teamColor = isAlly ? 0x26a9ff : 0xff2b3d;
            // 1. Official Riot ground crack fissures decal (blended dark into pit floor)
            const crackTex = zv?.crackTextureUrl ? champTextureCache.get(zv.crackTextureUrl) : undefined;
            const crackMat = createVfxBasicMat({
                map: crackTex || undefined,
                color: isAlly ? 0x6f558f : 0x804658,
                opacity: 0.72
            });
            materials.push(crackMat);
            const crackMesh = new THREE.Mesh(sharedZoneDecalGeo, crackMat);
            crackMesh.scale.setScalar(zone.radius);
            crackMesh.rotation.y = (zone.id * 1.37) % (Math.PI * 2);
            group.add(crackMesh);
            // 2. Official Riot indicator rim glow cylinder + crisp outer team circle
            const indTex = zv?.indicatorTextureUrl ? champTextureCache.get(zv.indicatorTextureUrl) : undefined;
            if (indTex) {
                const indMat = createVfxBasicMat({
                    map: indTex,
                    color: isAlly ? 0x9b6eff : 0xff3048,
                    opacity: 0.95,
                    blending: THREE.AdditiveBlending
                });
                materials.push(indMat);
                const indRim = new THREE.Mesh(sharedZoneRimCylinderGeo, indMat);
                indRim.scale.set(zone.radius, 1.4, zone.radius);
                indRim.position.y = 8;
                group.add(indRim);
            }
            const outerMat = createVfxBasicMat({
                color: teamColor,
                opacity: 0.92
            });
            materials.push(outerMat);
            const outerRing = new THREE.Mesh(sharedZoneOuterRingGeo, outerMat);
            outerRing.scale.setScalar(zone.radius);
            outerRing.position.y = 1.2;
            group.add(outerRing);
            // 3. Expanding detonation timer fill
            const fillMat = createVfxBasicMat({
                color: isAlly ? 0x6236ff : 0xff1e3c,
                opacity: 0.22,
                blending: THREE.AdditiveBlending
            });
            materials.push(fillMat);
            const fillMesh = new THREE.Mesh(sharedZoneFillGeo, fillMat);
            fillMesh.position.y = 0.6;
            group.add(fillMesh);
            scene.add(group);
            entry = { group, crackMesh, fillMesh, outerRing, rockTimer: 0, materials };
            activeGroundZoneMeshes.set(zone.id, entry);
        }
        const progress = zone.duration > 0 ? Math.max(0.05, Math.min(1, 1 - zone.remaining / zone.duration)) : 1;
        entry.fillMesh.scale.setScalar(zone.radius * progress);
        // Subtle ground tremor + pebble bounce right before eruption
        const tremor = progress * 3.5;
        entry.crackMesh.position.set((Math.random() - 0.5) * tremor, 0, (Math.random() - 0.5) * tremor);
        entry.rockTimer -= dt;
        if (entry.rockTimer <= 0) {
            entry.rockTimer = 0.085;
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * zone.radius * 0.85;
            spawnRockDebrisParticle(zone.x + Math.cos(a) * r, 6, zone.z + Math.sin(a) * r, (Math.random() - 0.5) * 40, 75 + Math.random() * 70, (Math.random() - 0.5) * 40, 16 + Math.random() * 14, 0.28);
        }
    }
    for (const [id, entry] of activeGroundZoneMeshes.entries()) {
        if (!seenZoneIds.has(id)) {
            scene.remove(entry.group);
            for (const m of entry.materials)
                m.dispose();
            activeGroundZoneMeshes.delete(id);
        }
    }
}
export function spawnZoneEruptionVfx(championId, x, z, radius) {
    const champ = getChampionConfig(championId);
    const zv = champ.q.archetype === 'delayed_ground_aoe' ? champ.q.zoneVisual : null;
    const eruptColor = zv?.eruptColorHex ?? 0xb833ff;
    spawnRingBurstVfx(x, z, eruptColor, radius * 0.3, radius * 1.15, 0.38);
    // 1. Lingering shattered ground crack crater
    const crackTex = zv?.crackTextureUrl ? champTextureCache.get(zv.crackTextureUrl) : undefined;
    if (crackTex) {
        const craterMat = createVfxBasicMat({
            map: crackTex,
            color: 0x735b8a,
            opacity: 0.8
        });
        const crater = new THREE.Mesh(sharedZoneDecalGeo, craterMat);
        crater.position.set(x, 2.5, z);
        crater.scale.setScalar(radius);
        crater.rotation.y = Math.random() * Math.PI * 2;
        scene.add(crater);
        transientVfx.push({
            mesh: crater,
            age: 0,
            duration: 0.85,
            update() {
                const t = this.age / this.duration;
                craterMat.opacity = 0.92 * (1 - Math.pow(t, 1.8));
            },
            onDispose() {
                craterMat.dispose();
            }
        });
    }
    // 2. Official Riot 3D Rupture spike cluster mesh (chogath_q_spikes.obj)
    const spikeTemplate = getCachedZoneMeshTemplate(championId);
    const spikeGroup = new THREE.Group();
    spikeGroup.position.set(x, 0, z);
    const baseRadius = zv?.meshBaseRadius || 116.5;
    const horizScale = radius / baseRadius;
    const vertScale = horizScale * 1.45;
    const spikeMats = [];
    if (spikeTemplate) {
        const clone = spikeTemplate.clone();
        clone.traverse((child) => {
            if (child.isMesh) {
                const mesh = child;
                if (mesh.material && !Array.isArray(mesh.material)) {
                    const mat = mesh.material.clone();
                    mesh.material = mat;
                    spikeMats.push(mat);
                }
            }
        });
        clone.rotation.y = Math.random() * Math.PI * 2;
        spikeGroup.add(clone);
    }
    else {
        const fallbackMat = new THREE.MeshStandardMaterial({
            color: zv?.spikeColorHex ?? 0xdfd0f7,
            emissive: new THREE.Color(eruptColor),
            emissiveIntensity: 0.5,
            transparent: true,
            opacity: 0.96
        });
        spikeMats.push(fallbackMat);
        for (let i = 0; i < 8; i++) {
            const m = new THREE.Mesh(sharedFallbackSpikeGeo, fallbackMat);
            const a = (i / 8) * Math.PI * 2;
            const r = i === 0 ? 0 : baseRadius * 0.55;
            m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
            spikeGroup.add(m);
        }
    }
    spikeGroup.scale.set(horizScale, 0.05, horizScale);
    spikeGroup.position.y = -95;
    scene.add(spikeGroup);
    transientVfx.push({
        mesh: spikeGroup,
        age: 0,
        duration: 0.72,
        update() {
            const t = this.age / this.duration;
            let yFactor;
            if (t < 0.14) {
                // Violent upward eruption
                const k = t / 0.14;
                yFactor = 1 - Math.pow(1 - k, 3);
            }
            else if (t < 0.58) {
                // Hold jagged spikes protruding from ground
                yFactor = 1;
            }
            else {
                // Sink cleanly back into earth
                const k = (t - 0.58) / 0.42;
                yFactor = Math.max(0.05, 1 - k * k);
            }
            spikeGroup.scale.set(horizScale, vertScale * yFactor, horizScale);
            spikeGroup.position.y = -95 * (1 - yFactor);
            const opacity = t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1;
            for (const m of spikeMats) {
                m.opacity = opacity;
            }
        },
        onDispose() {
            for (const m of spikeMats)
                m.dispose();
        }
    });
    // 3. Official Riot Void smoke rays shooting up from the rupture (single shared material)
    const smokeTex = zv?.smokeTextureUrl ? champTextureCache.get(zv.smokeTextureUrl) : undefined;
    if (smokeTex) {
        const smokeGroup = new THREE.Group();
        smokeGroup.position.set(x, 0, z);
        const smokeMat = createVfxBasicMat({
            map: smokeTex,
            color: eruptColor,
            opacity: 0.72,
            blending: THREE.AdditiveBlending
        });
        for (let i = 0; i < 3; i++) {
            const plane = new THREE.Mesh(sharedSmokeRayGeo, smokeMat);
            plane.rotation.y = (i * Math.PI) / 3;
            plane.scale.set(radius * 1.4, radius * 1.35, 1);
            smokeGroup.add(plane);
        }
        scene.add(smokeGroup);
        transientVfx.push({
            mesh: smokeGroup,
            age: 0,
            duration: 0.48,
            update() {
                const t = this.age / this.duration;
                smokeGroup.scale.set(1 + t * 0.25, 1 + t * 0.35, 1 + t * 0.25);
                smokeMat.opacity = 0.72 * Math.pow(1 - t, 1.4);
            },
            onDispose() {
                smokeMat.dispose();
            }
        });
    }
    // 4. Flying rock shards & Void sparkles
    for (let i = 0; i < 14; i++) {
        const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.35;
        const r = Math.random() * radius * 0.75;
        spawnRockDebrisParticle(x + Math.cos(angle) * r, 18, z + Math.sin(angle) * r, Math.cos(angle) * (65 + Math.random() * 90), 200 + Math.random() * 170, Math.sin(angle) * (65 + Math.random() * 90), 22 + Math.random() * 18, 0.55 + Math.random() * 0.22);
    }
}
const MAX_RING_BURSTS = 12;
const ringBurstPool = [];
for (let i = 0; i < MAX_RING_BURSTS; i++) {
    const mat = createVfxBasicMat({
        color: 0xffffff,
        opacity: 0.9,
        blending: THREE.AdditiveBlending
    });
    const mesh = new THREE.Mesh(sharedRingBurstGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    ringBurstPool.push({
        mesh,
        mat,
        active: false,
        age: 0,
        duration: 0.42,
        baseScale: 20,
        scaleRatio: 1
    });
}
export function spawnRingBurstVfx(x, z, colorHex, startR = 20, endR = 135, duration = 0.42) {
    let slot = ringBurstPool[0];
    let maxAge = -1;
    for (const entry of ringBurstPool) {
        if (!entry.active) {
            slot = entry;
            break;
        }
        if (entry.age > maxAge) {
            maxAge = entry.age;
            slot = entry;
        }
    }
    const baseScale = Math.max(1, startR);
    slot.active = true;
    slot.age = 0;
    slot.duration = duration;
    slot.baseScale = baseScale;
    slot.scaleRatio = endR / baseScale;
    slot.mat.color.setHex(colorHex);
    slot.mat.opacity = 0.9;
    slot.mesh.position.set(x, 6, z);
    slot.mesh.scale.setScalar(baseScale);
    slot.mesh.visible = true;
}
let moveArrowBladeGeo = null;
let moveArrowTexture = null;
function getMoveArrowAssets() {
    if (!moveArrowBladeGeo) {
        const segments = 12;
        const positions = [];
        const uvs = [];
        const indices = [];
        for (let i = 0; i <= segments; i++) {
            const s = i / segments;
            const r = 46 * (1 - s) + 3 * s;
            const y = 44 * Math.pow(1 - s, 1.55) + 2;
            let halfW;
            if (s < 0.65) {
                const k = s / 0.65;
                halfW = 10.5 * (1 - k) + 4.2 * k;
            }
            else if (s < 0.78) {
                const k = (s - 0.65) / 0.13;
                halfW = 4.2 * (1 - k) + 8.8 * k;
            }
            else {
                const k = (s - 0.78) / 0.22;
                halfW = 8.8 * (1 - k) + 0.3 * k;
            }
            positions.push(r, y, -halfW);
            uvs.push(s, 0);
            positions.push(r, y, halfW);
            uvs.push(s, 1);
            if (i < segments) {
                const base = i * 2;
                indices.push(base, base + 1, base + 2);
                indices.push(base + 1, base + 3, base + 2);
            }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        moveArrowBladeGeo = geo;
    }
    if (!moveArrowTexture) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 64);
        grad.addColorStop(0, '#0b5c0b');
        grad.addColorStop(0.14, '#38ff24');
        grad.addColorStop(0.5, '#7bff52');
        grad.addColorStop(0.86, '#38ff24');
        grad.addColorStop(1, '#0b5c0b');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = 'rgba(10, 70, 10, 0.75)';
        ctx.fillRect(0, 0, 4, 64);
        ctx.fillRect(60, 0, 4, 64);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        moveArrowTexture = tex;
    }
    return { geo: moveArrowBladeGeo, tex: moveArrowTexture };
}
const MAX_MOVE_INDICATORS = 8;
const moveIndicatorPool = [];
function ensureMoveIndicatorPool() {
    if (moveIndicatorPool.length > 0)
        return moveIndicatorPool;
    const { geo, tex } = getMoveArrowAssets();
    const angles = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    for (let i = 0; i < MAX_MOVE_INDICATORS; i++) {
        const group = new THREE.Group();
        const mat = createVfxBasicMat({
            map: tex,
            color: 0xffffff,
            opacity: 0.96
        });
        for (const ang of angles) {
            const blade = new THREE.Mesh(geo, mat);
            blade.rotation.y = ang;
            group.add(blade);
        }
        group.visible = false;
        scene.add(group);
        moveIndicatorPool.push({
            group,
            mat,
            active: false,
            age: 0,
            duration: 0.34
        });
    }
    return moveIndicatorPool;
}
export function spawnMoveClickIndicator(x, z) {
    const pool = ensureMoveIndicatorPool();
    let slot = pool[0];
    let maxAge = -1;
    for (const entry of pool) {
        if (!entry.active) {
            slot = entry;
            break;
        }
        if (entry.age > maxAge) {
            maxAge = entry.age;
            slot = entry;
        }
    }
    slot.active = true;
    slot.age = 0;
    slot.duration = 0.34;
    slot.group.position.set(x, 2, z);
    slot.group.scale.setScalar(1.05);
    slot.mat.opacity = 0.96;
    slot.group.visible = true;
}
function createSkybeamMesh(x, z, colorHex, width, height) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const mat = createVfxBasicMat({
        map: vfxTextures.skybeamGlow || undefined,
        color: colorHex,
        opacity: 0.92,
        blending: THREE.AdditiveBlending
    });
    const angles = [0, Math.PI / 3, (2 * Math.PI) / 3];
    for (const ang of angles) {
        const plane = new THREE.Mesh(sharedSkybeamGeo, mat);
        plane.scale.set(width, height, 1);
        plane.rotation.y = ang;
        group.add(plane);
    }
    return { group, mat };
}
function syncSparkleMap() {
    const tex = vfxTextures.flashSpark || vfxTextures.flashHalo || null;
    if (sparkleUniforms.uMap.value !== tex) {
        sparkleUniforms.uMap.value = tex;
        sparkleUniforms.uHasMap.value = tex ? 1.0 : 0.0;
    }
}
function allocSparkleSlot(x, y, z, vx, vy, vz, colorHex, size, duration, kind, initialAlpha) {
    syncSparkleMap();
    let slot = -1;
    let maxAge = -1;
    for (let i = 0; i < MAX_SPARKLES; i++) {
        if (sparkleDurations[i] <= 0) {
            slot = i;
            break;
        }
        if (sparkleAges[i] > maxAge) {
            maxAge = sparkleAges[i];
            slot = i;
        }
    }
    if (slot === -1)
        slot = 0;
    const idx = slot * 3;
    sparklePositions[idx] = x;
    sparklePositions[idx + 1] = y;
    sparklePositions[idx + 2] = z;
    sparkleVelocities[idx] = vx;
    sparkleVelocities[idx + 1] = vy;
    sparkleVelocities[idx + 2] = vz;
    _tempColor.setHex(colorHex);
    sparkleColors[idx] = _tempColor.r;
    sparkleColors[idx + 1] = _tempColor.g;
    sparkleColors[idx + 2] = _tempColor.b;
    sparkleBaseSizes[slot] = size;
    sparkleSizes[slot] = size;
    sparkleAlphas[slot] = initialAlpha;
    sparkleAges[slot] = 0;
    sparkleDurations[slot] = duration;
    sparkleKinds[slot] = kind;
    if (sparkleDurations[slot] > 0) {
        sparkleActiveCount = Math.max(sparkleActiveCount, 1);
    }
    sparklePoints.visible = true;
    sparklePosAttr.needsUpdate = true;
    sparkleColorAttr.needsUpdate = true;
    sparkleSizeAttr.needsUpdate = true;
    sparkleAlphaAttr.needsUpdate = true;
}
function spawnSparkleParticle(x, y, z, vx, vy, vz, colorHex, size, duration) {
    allocSparkleSlot(x, y, z, vx, vy, vz, colorHex, size, duration, 0, 1.0);
}
function updateSparklePool(dt) {
    if (sparkleActiveCount === 0)
        return;
    let active = 0;
    for (let i = 0; i < MAX_SPARKLES; i++) {
        const dur = sparkleDurations[i];
        if (dur <= 0)
            continue;
        sparkleAges[i] += dt;
        const idx = i * 3;
        if (sparkleAges[i] >= dur) {
            sparkleDurations[i] = 0;
            sparkleAlphas[i] = 0;
            sparklePositions[idx + 1] = -9999;
            continue;
        }
        active += 1;
        const age = sparkleAges[i];
        const t = age / dur;
        sparklePositions[idx] += sparkleVelocities[idx] * dt;
        sparklePositions[idx + 1] += sparkleVelocities[idx + 1] * dt;
        sparklePositions[idx + 2] += sparkleVelocities[idx + 2] * dt;
        if (sparkleKinds[i] === 0) {
            const pulse = 0.8 + 0.35 * Math.sin(age * 28);
            sparkleSizes[i] = sparkleBaseSizes[i] * (1 - t * 0.55) * pulse;
            sparkleAlphas[i] = Math.max(0, 1 - Math.pow(t, 1.5));
        }
        else {
            sparkleSizes[i] = sparkleBaseSizes[i] * (1 - t * 0.45);
            sparkleAlphas[i] = 0.72 * Math.pow(1 - t, 1.3);
        }
    }
    sparkleActiveCount = active;
    sparklePosAttr.needsUpdate = true;
    sparkleSizeAttr.needsUpdate = true;
    sparkleAlphaAttr.needsUpdate = true;
    if (active === 0) {
        sparklePoints.visible = false;
    }
}
function spawnFlashBurstAtPoint(x, z, isDestination) {
    const beamWidth = isDestination ? 44 : 38;
    const beamHeight = isDestination ? 560 : 480;
    const { group: beamGroup, mat: beamMat } = createSkybeamMesh(x, z, 0xfff088, beamWidth, beamHeight);
    scene.add(beamGroup);
    transientVfx.push({
        mesh: beamGroup,
        age: 0,
        duration: 0.42,
        update() {
            const t = this.age / this.duration;
            const widthScale = Math.max(0.15, 1 - t * 0.75);
            beamGroup.scale.set(widthScale, 1 + t * 0.12, widthScale);
            beamMat.opacity = 0.95 * Math.pow(1 - t, 1.6);
        },
        onDispose() {
            beamMat.dispose();
        }
    });
    const burstGroup = new THREE.Group();
    burstGroup.position.set(x, 4, z);
    const haloMat = createVfxBasicMat({
        map: vfxTextures.flashHalo || vfxTextures.flashBurst || undefined,
        color: 0xffb82e,
        opacity: 0.9,
        blending: THREE.AdditiveBlending
    });
    burstGroup.add(new THREE.Mesh(sharedFlashHaloGeo, haloMat));
    const starMat = createVfxBasicMat({
        map: vfxTextures.flashBurst || undefined,
        color: 0xfff59e,
        opacity: 0.98,
        blending: THREE.AdditiveBlending
    });
    const starMesh = new THREE.Mesh(sharedFlashStarGeo, starMat);
    starMesh.position.y = 2;
    burstGroup.add(starMesh);
    scene.add(burstGroup);
    transientVfx.push({
        mesh: burstGroup,
        age: 0,
        duration: 0.38,
        update() {
            const t = this.age / this.duration;
            const s = 0.75 + 0.85 * (1 - Math.pow(1 - t, 2));
            burstGroup.scale.setScalar(s);
            haloMat.opacity = 0.9 * (1 - t);
            starMat.opacity = 0.98 * Math.pow(1 - t, 1.4);
        },
        onDispose() {
            haloMat.dispose();
            starMat.dispose();
        }
    });
    const sparkCount = 14;
    for (let i = 0; i < sparkCount; i++) {
        const angle = (i / sparkCount) * Math.PI * 2 + Math.random() * 0.4;
        const r = 18 + Math.random() * 68;
        const sx = x + Math.cos(angle) * r;
        const sz = z + Math.sin(angle) * r;
        const sy = 14 + Math.random() * 85;
        const speed = 45 + Math.random() * 95;
        spawnSparkleParticle(sx, sy, sz, Math.cos(angle) * speed, 35 + Math.random() * 75, Math.sin(angle) * speed, 0xffe97d, 34 + Math.random() * 24, 0.32 + Math.random() * 0.22);
    }
}
export function spawnFlashVfx(slot, fromX, fromZ, toX, toZ) {
    const rig = championRigs[slot];
    if (rig) {
        rig.triggerFlashBlink(toX, toZ);
    }
    spawnFlashBurstAtPoint(fromX, fromZ, false);
    spawnFlashBurstAtPoint(toX, toZ, true);
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const trailCount = 14;
    for (let i = 0; i < trailCount; i++) {
        const frac = (i + 0.5) / trailCount;
        const jitterX = (Math.random() - 0.5) * 42;
        const jitterZ = (Math.random() - 0.5) * 42;
        const px = fromX + dx * frac + jitterX;
        const pz = fromZ + dz * frac + jitterZ;
        const py = 35 + Math.random() * 95;
        spawnSparkleParticle(px, py, pz, (Math.random() - 0.5) * 40, 25 + Math.random() * 55, (Math.random() - 0.5) * 40, 0xffdf55, 28 + Math.random() * 18, 0.28 + frac * 0.22);
    }
}
export function spawnHealVfx(slot, x, z) {
    const rig = championRigs[slot];
    if (rig) {
        rig.triggerHealOverlay();
    }
    const healGroup = new THREE.Group();
    healGroup.position.set(x, 5, z);
    const burstMat1 = createVfxBasicMat({
        map: vfxTextures.flashBurst || undefined,
        color: 0x2eff5e,
        opacity: 0.95,
        blending: THREE.AdditiveBlending
    });
    const burstMesh1 = new THREE.Mesh(sharedHealBurst1Geo, burstMat1);
    healGroup.add(burstMesh1);
    const burstMat2 = createVfxBasicMat({
        map: vfxTextures.flashBurst || undefined,
        color: 0x7dffaa,
        opacity: 0.88,
        blending: THREE.AdditiveBlending
    });
    const burstMesh2 = new THREE.Mesh(sharedHealBurst2Geo, burstMat2);
    burstMesh2.position.y = 2;
    healGroup.add(burstMesh2);
    const boltMat = createVfxBasicMat({
        map: vfxTextures.healBolts || vfxTextures.healWisps || undefined,
        color: 0x39ff7a,
        opacity: 0.9,
        blending: THREE.AdditiveBlending
    });
    const boltCylinder = new THREE.Mesh(sharedHealBoltGeo, boltMat);
    boltCylinder.position.y = 48;
    healGroup.add(boltCylinder);
    scene.add(healGroup);
    transientVfx.push({
        mesh: healGroup,
        age: 0,
        duration: 0.62,
        update(dt) {
            const t = this.age / this.duration;
            const expand = 0.65 + 0.85 * (1 - Math.pow(1 - t, 2.2));
            burstMesh1.scale.setScalar(expand);
            burstMesh2.scale.setScalar(expand * 0.92);
            burstMesh2.rotation.y += dt * 1.8;
            boltCylinder.rotation.y -= dt * 4.5;
            boltCylinder.scale.set(0.85 + t * 0.55, 1 + t * 0.3, 0.85 + t * 0.55);
            const fade = Math.pow(1 - t, 1.4);
            burstMat1.opacity = 0.95 * fade;
            burstMat2.opacity = 0.85 * fade;
            boltMat.opacity = 0.9 * fade;
        },
        onDispose() {
            burstMat1.dispose();
            burstMat2.dispose();
            boltMat.dispose();
        }
    });
    for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.3;
        const r = 24 + Math.random() * 64;
        spawnSparkleParticle(x + Math.cos(angle) * r, 18 + Math.random() * 70, z + Math.sin(angle) * r, Math.cos(angle) * 28, 85 + Math.random() * 75, Math.sin(angle) * 28, i % 3 === 0 ? 0x5effd8 : 0x44ff6e, 30 + Math.random() * 20, 0.42 + Math.random() * 0.25);
    }
}
export function spawnGhostVfx(_slot, x, z) {
    const group = new THREE.Group();
    group.position.set(x, 65, z);
    const cylMat = createVfxBasicMat({
        map: vfxTextures.hasteShockwave || vfxTextures.ghostTrail || undefined,
        color: 0x22d8ff,
        opacity: 0.92,
        blending: THREE.AdditiveBlending
    });
    const shockMesh = new THREE.Mesh(sharedGhostCylGeo, cylMat);
    group.add(shockMesh);
    scene.add(group);
    transientVfx.push({
        mesh: group,
        age: 0,
        duration: 0.45,
        update(dt) {
            const t = this.age / this.duration;
            shockMesh.rotation.y += dt * 7.5;
            group.scale.set(0.8 + t * 0.75, 1 + t * 0.25, 0.8 + t * 0.75);
            cylMat.opacity = 0.92 * Math.pow(1 - t, 1.3);
        },
        onDispose() {
            cylMat.dispose();
        }
    });
}
const MAX_GHOST_RIBBONS = 24;
const ghostRibbonPool = [];
for (let i = 0; i < MAX_GHOST_RIBBONS; i++) {
    const mat = createVfxBasicMat({
        color: 0x24c8ff,
        opacity: 0.68,
        blending: THREE.AdditiveBlending
    });
    const mesh = new THREE.Mesh(sharedGhostRibbonGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    ghostRibbonPool.push({
        mesh,
        mat,
        active: false,
        age: 0,
        duration: 0.36,
        backX: 0,
        backZ: 0
    });
}
export function spawnGhostTrailStep(x, z, facingAngle) {
    const backX = -Math.sin(facingAngle);
    const backZ = -Math.cos(facingAngle);
    const sideX = Math.cos(facingAngle);
    const sideZ = -Math.sin(facingAngle);
    let ribbonSlot = ghostRibbonPool[0];
    let maxAge = -1;
    for (const entry of ghostRibbonPool) {
        if (!entry.active) {
            ribbonSlot = entry;
            break;
        }
        if (entry.age > maxAge) {
            maxAge = entry.age;
            ribbonSlot = entry;
        }
    }
    const ribbonTex = vfxTextures.ghostTrail || vfxTextures.hasteShockwave || null;
    if (ribbonSlot.mat.map !== ribbonTex) {
        ribbonSlot.mat.map = ribbonTex;
        ribbonSlot.mat.needsUpdate = true;
    }
    const lateralOffset = (Math.random() - 0.5) * 48;
    const heightOffset = 35 + Math.random() * 85;
    ribbonSlot.active = true;
    ribbonSlot.age = 0;
    ribbonSlot.duration = 0.36;
    ribbonSlot.backX = backX;
    ribbonSlot.backZ = backZ;
    ribbonSlot.mesh.position.set(x + backX * 28 + sideX * lateralOffset, heightOffset, z + backZ * 28 + sideZ * lateralOffset);
    ribbonSlot.mesh.rotation.y = facingAngle + Math.PI / 2;
    ribbonSlot.mesh.rotation.z = (Math.random() - 0.5) * 0.35;
    ribbonSlot.mesh.scale.set(1, 1, 1);
    ribbonSlot.mat.opacity = 0.68;
    ribbonSlot.mesh.visible = true;
    const isGreenOrb = Math.random() < 0.62;
    const orbLat = (Math.random() - 0.5) * 44;
    const startScale = isGreenOrb ? 54 : 42;
    allocSparkleSlot(x + backX * 36 + sideX * orbLat, 65 + Math.random() * 65, z + backZ * 36 + sideZ * orbLat, backX * 70, 18, backZ * 70, isGreenOrb ? 0x22ff68 : 0x1ec8ff, startScale, 0.44, 1, 0.72);
}
function updatePooledVfx(dt) {
    for (let i = 0; i < MAX_RING_BURSTS; i++) {
        const r = ringBurstPool[i];
        if (!r.active)
            continue;
        r.age += dt;
        if (r.age >= r.duration) {
            r.active = false;
            r.mesh.visible = false;
        }
        else {
            const t = r.age / r.duration;
            const s = r.baseScale * (1 + (r.scaleRatio - 1) * (1 - Math.pow(1 - t, 2)));
            r.mesh.scale.setScalar(s);
            r.mat.opacity = 0.9 * (1 - t);
        }
    }
    for (let i = 0; i < moveIndicatorPool.length; i++) {
        const m = moveIndicatorPool[i];
        if (!m.active)
            continue;
        m.age += dt;
        if (m.age >= m.duration) {
            m.active = false;
            m.group.visible = false;
        }
        else {
            const t = m.age / m.duration;
            const ease = 1 - Math.pow(1 - t, 2);
            m.group.scale.setScalar(1.05 - 0.68 * ease);
            m.mat.opacity = t < 0.45 ? 0.96 : 0.96 * (1 - (t - 0.45) / 0.55);
        }
    }
    for (let i = 0; i < MAX_GHOST_RIBBONS; i++) {
        const g = ghostRibbonPool[i];
        if (!g.active)
            continue;
        g.age += dt;
        if (g.age >= g.duration) {
            g.active = false;
            g.mesh.visible = false;
        }
        else {
            const t = g.age / g.duration;
            g.mesh.position.x += g.backX * 95 * dt;
            g.mesh.position.z += g.backZ * 95 * dt;
            g.mesh.scale.set(1 + t * 0.45, Math.max(0.2, 1 - t * 0.6), 1);
            g.mat.opacity = 0.68 * (1 - t);
        }
    }
}
export function updateTransientVfx(dt) {
    updateRockDebrisPool(dt);
    updateSparklePool(dt);
    updatePooledVfx(dt);
    for (let i = transientVfx.length - 1; i >= 0; i--) {
        const vfx = transientVfx[i];
        vfx.age += dt;
        if (vfx.age >= vfx.duration) {
            scene.remove(vfx.mesh);
            vfx.onDispose?.();
            const last = transientVfx.length - 1;
            if (i !== last) {
                transientVfx[i] = transientVfx[last];
            }
            transientVfx.pop();
        }
        else {
            vfx.update(dt);
        }
    }
}
/**
 * Compile and keep alive all VFX shader programs + GPU textures during startup
 * loading so casting abilities or summoner spells never triggers mid-match stutters.
 */
export function prewarmAllVfxShaders() {
    if (prewarmedVfxMats.length > 0)
        return;
    for (const tex of Object.values(vfxTextures)) {
        if (tex)
            renderer.initTexture(tex);
    }
    for (const tex of champTextureCache.values()) {
        renderer.initTexture(tex);
    }
    syncSparkleMap();
    ensureMoveIndicatorPool();
    const warmupGroup = new THREE.Group();
    warmupGroup.position.set(0, 5, 0);
    warmupGroup.scale.setScalar(0.0001);
    const basicNormal = createVfxBasicMat({
        map: vfxTextures.flashBurst || undefined
    });
    const basicAdd = createVfxBasicMat({
        map: vfxTextures.skybeamGlow || undefined,
        blending: THREE.AdditiveBlending
    });
    const basicAddSolid = createVfxBasicMat({
        color: 0xffffff,
        blending: THREE.AdditiveBlending
    });
    const basicSolidRing = createVfxBasicMat({
        color: 0xffffff
    });
    prewarmedVfxMats.push(basicNormal, basicAdd, basicAddSolid, basicSolidRing, sparkleShaderMat);
    warmupGroup.add(new THREE.Mesh(sharedZoneDecalGeo, basicNormal));
    warmupGroup.add(new THREE.Mesh(sharedSmokeRayGeo, basicAdd));
    warmupGroup.add(new THREE.Mesh(sharedZoneFillGeo, basicAddSolid));
    warmupGroup.add(new THREE.Mesh(sharedRingBurstGeo, basicSolidRing));
    for (const champ of CHAMPION_LIST) {
        const projTpl = getCachedProjectileTemplate(champ.id);
        if (projTpl) {
            const clone = projTpl.clone();
            clone.traverse((child) => {
                const mesh = child;
                if (mesh.isMesh && mesh.material && !Array.isArray(mesh.material)) {
                    prewarmedVfxMats.push(mesh.material);
                }
            });
            warmupGroup.add(clone);
        }
        const zoneTpl = getCachedZoneMeshTemplate(champ.id);
        if (zoneTpl) {
            const clone = zoneTpl.clone();
            clone.traverse((child) => {
                const mesh = child;
                if (mesh.isMesh && mesh.material && !Array.isArray(mesh.material)) {
                    prewarmedVfxMats.push(mesh.material);
                }
            });
            warmupGroup.add(clone);
        }
    }
    warmupGroup.traverse((child) => {
        child.frustumCulled = false;
    });
    const prevDebrisVis = debrisPoints.visible;
    const prevSparkleVis = sparklePoints.visible;
    debrisPoints.visible = true;
    sparklePoints.visible = true;
    scene.add(warmupGroup);
    renderer.compile(scene, camera);
    // Perform one micro draw pass so ANGLE/Metal also builds final GPU pipelines upfront
    renderer.render(scene, camera);
    scene.remove(warmupGroup);
    debrisPoints.visible = prevDebrisVis;
    sparklePoints.visible = prevSparkleVis;
}
// ============================================================================
// DYNAMIC SKILLSHOT INDICATOR (LINE OR GROUND AOE CIRCLE PER CHAMPION)
// ============================================================================
const lineIndicatorGroup = new THREE.Group();
lineIndicatorGroup.visible = false;
scene.add(lineIndicatorGroup);
const lineIndicatorMat = createVfxBasicMat({
    color: 0x0ac8b9,
    opacity: 0.32
});
const lineGeoCache = new Map();
const lineIndicatorMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lineIndicatorMat);
lineIndicatorMesh.position.y = 4;
lineIndicatorGroup.add(lineIndicatorMesh);
const circleRangeRingGeo = new THREE.RingGeometry(0.985, 1.0, 64);
circleRangeRingGeo.rotateX(-Math.PI / 2);
const circleRangeRingMat = createVfxBasicMat({
    color: 0x0ac8b9,
    opacity: 0.42
});
const circleRangeMesh = new THREE.Mesh(circleRangeRingGeo, circleRangeRingMat);
circleRangeMesh.visible = false;
circleRangeMesh.position.y = 3;
scene.add(circleRangeMesh);
const circleTargetGroup = new THREE.Group();
circleTargetGroup.visible = false;
scene.add(circleTargetGroup);
const circleTargetFillMat = createVfxBasicMat({
    color: 0xb833ff,
    opacity: 0.25
});
const circleTargetFill = new THREE.Mesh(sharedZoneFillGeo, circleTargetFillMat);
circleTargetFill.position.y = 4;
circleTargetGroup.add(circleTargetFill);
const circleTargetRimMat = createVfxBasicMat({
    color: 0x0ac8b9,
    opacity: 0.88
});
const circleTargetRim = new THREE.Mesh(sharedZoneOuterRingGeo, circleTargetRimMat);
circleTargetRim.position.y = 4.5;
circleTargetGroup.add(circleTargetRim);
export function updateSkillshotIndicator() {
    const myPlayer = state.serverPlayers[state.mySlot];
    if (!state.showSkillshotIndicator ||
        !myPlayer ||
        !myPlayer.alive ||
        state.roomState !== 'playing') {
        lineIndicatorGroup.visible = false;
        circleRangeMesh.visible = false;
        circleTargetGroup.visible = false;
        return;
    }
    const champ = getChampionConfig(myPlayer.championId);
    const ind = champ.q.indicator;
    if (ind.shape === 'line') {
        circleRangeMesh.visible = false;
        circleTargetGroup.visible = false;
        lineIndicatorGroup.visible = true;
        const key = `${ind.width}x${ind.range}`;
        let geo = lineGeoCache.get(key);
        if (!geo) {
            geo = new THREE.PlaneGeometry(ind.width, ind.range);
            geo.translate(0, ind.range / 2, 0);
            geo.rotateX(-Math.PI / 2);
            lineGeoCache.set(key, geo);
        }
        if (lineIndicatorMesh.geometry !== geo) {
            lineIndicatorMesh.geometry = geo;
        }
        lineIndicatorMat.color.setHex(ind.colorHex);
        lineIndicatorGroup.position.set(myPlayer.x, 0, myPlayer.z);
        const dx = state.mouseWorld.x - myPlayer.x;
        const dz = state.mouseWorld.z - myPlayer.z;
        lineIndicatorGroup.rotation.y = Math.atan2(dx, dz) + Math.PI;
        return;
    }
    lineIndicatorGroup.visible = false;
    circleRangeMesh.visible = true;
    circleRangeMesh.position.set(myPlayer.x, 3, myPlayer.z);
    circleRangeMesh.scale.setScalar(ind.range);
    circleRangeRingMat.color.setHex(0x0ac8b9);
    circleTargetGroup.visible = true;
    const dx = state.mouseWorld.x - myPlayer.x;
    const dz = state.mouseWorld.z - myPlayer.z;
    const dist = Math.hypot(dx, dz);
    const clampedDist = Math.min(dist, ind.range);
    const tx = dist > 1e-3 ? myPlayer.x + (dx / dist) * clampedDist : myPlayer.x;
    const tz = dist > 1e-3 ? myPlayer.z + (dz / dist) * clampedDist : myPlayer.z;
    circleTargetGroup.position.set(tx, 0, tz);
    circleTargetFill.scale.setScalar(ind.radius);
    circleTargetRim.scale.setScalar(ind.radius);
    circleTargetFillMat.color.setHex(ind.colorHex);
    circleTargetRimMat.color.setHex(0x0ac8b9);
}
