import * as THREE from 'three';
import { getChampionConfig } from '../shared/champions/index.js';
import { championRigs, getCachedProjectileTemplate } from './champion.js';
import { scene, vfxTextures } from './scene.js';
import { state } from './state.js';
const activeProjectileMeshes = new Map();
const activeGroundZoneMeshes = new Map();
const transientVfx = [];
const seenProjIds = new Set();
const seenZoneIds = new Set();
// Shared reusable geometries (never disposed per-effect, zero runtime allocations)
const sharedUnitRingGeo = new THREE.RingGeometry(0.7, 0.93, 28);
sharedUnitRingGeo.rotateX(-Math.PI / 2);
const sharedZoneOuterRingGeo = new THREE.RingGeometry(0.92, 1.0, 48);
sharedZoneOuterRingGeo.rotateX(-Math.PI / 2);
const sharedZoneRuneRingGeo = new THREE.RingGeometry(0.58, 0.67, 6);
sharedZoneRuneRingGeo.rotateX(-Math.PI / 2);
const sharedZoneFillGeo = new THREE.CircleGeometry(1, 40);
sharedZoneFillGeo.rotateX(-Math.PI / 2);
const sharedVoidSpikeGeo = new THREE.ConeGeometry(16, 130, 5);
sharedVoidSpikeGeo.translate(0, 65, 0);
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
            const ringMat = new THREE.MeshBasicMaterial({
                color: proj.ownerSlot === state.mySlot ? 0x26a9ff : 0xff4254,
                transparent: true,
                opacity: 0.55,
                side: THREE.DoubleSide,
                depthWrite: false
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
export function syncGroundZones(dt) {
    seenZoneIds.clear();
    for (const zone of state.serverGroundZones) {
        seenZoneIds.add(zone.id);
        let entry = activeGroundZoneMeshes.get(zone.id);
        const isAlly = zone.ownerSlot === state.mySlot;
        const champ = getChampionConfig(zone.championId);
        const defaultColor = champ.q.archetype === 'delayed_ground_aoe' ? champ.q.zoneVisual.telegraphColorHex : 0xff2f6d;
        if (!entry) {
            const group = new THREE.Group();
            group.position.set(zone.x, 3.5, zone.z);
            const ringColor = isAlly ? 0x9b5cff : defaultColor;
            const outerMat = new THREE.MeshBasicMaterial({
                color: ringColor,
                transparent: true,
                opacity: 0.92,
                side: THREE.DoubleSide,
                depthWrite: false
            });
            const outerMesh = new THREE.Mesh(sharedZoneOuterRingGeo, outerMat);
            outerMesh.scale.setScalar(zone.radius);
            group.add(outerMesh);
            const runeMat = new THREE.MeshBasicMaterial({
                color: isAlly ? 0xd29bff : 0xff6b8b,
                transparent: true,
                opacity: 0.72,
                side: THREE.DoubleSide,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            const runeMesh = new THREE.Mesh(sharedZoneRuneRingGeo, runeMat);
            runeMesh.scale.setScalar(zone.radius);
            runeMesh.position.y = 0.8;
            group.add(runeMesh);
            const fillMat = new THREE.MeshBasicMaterial({
                color: ringColor,
                transparent: true,
                opacity: 0.28,
                side: THREE.DoubleSide,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            const fillMesh = new THREE.Mesh(sharedZoneFillGeo, fillMat);
            fillMesh.position.y = 0.4;
            group.add(fillMesh);
            scene.add(group);
            entry = {
                group,
                fillMesh,
                runeMesh,
                materials: [outerMat, runeMat, fillMat]
            };
            activeGroundZoneMeshes.set(zone.id, entry);
        }
        const progress = zone.duration > 0 ? Math.max(0.05, Math.min(1, 1 - zone.remaining / zone.duration)) : 1;
        entry.fillMesh.scale.setScalar(zone.radius * progress);
        entry.runeMesh.rotation.y += dt * 1.9;
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
    const eruptColor = champ.q.archetype === 'delayed_ground_aoe' ? champ.q.zoneVisual.eruptColorHex : 0xb833ff;
    const spikeColor = champ.q.archetype === 'delayed_ground_aoe' ? champ.q.zoneVisual.spikeColorHex : 0x3b1259;
    spawnRingBurstVfx(x, z, eruptColor, radius * 0.25, radius * 1.15, 0.42);
    const spikeGroup = new THREE.Group();
    spikeGroup.position.set(x, 0, z);
    const spikeMat = new THREE.MeshStandardMaterial({
        color: spikeColor,
        emissive: new THREE.Color(eruptColor),
        emissiveIntensity: 0.65,
        roughness: 0.35,
        metalness: 0.35,
        transparent: true,
        opacity: 0.96
    });
    const spikeCount = 13;
    const spikes = [];
    for (let i = 0; i < spikeCount; i++) {
        const isCenter = i < 3;
        const dist = isCenter ? Math.random() * radius * 0.25 : radius * (0.35 + Math.random() * 0.55);
        const angle = (i / spikeCount) * Math.PI * 2 + Math.random() * 0.4;
        const mesh = new THREE.Mesh(sharedVoidSpikeGeo, spikeMat);
        mesh.position.set(Math.cos(angle) * dist, -55, Math.sin(angle) * dist);
        mesh.rotation.set((Math.random() - 0.5) * 0.48, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.48);
        const maxScale = isCenter ? 1.2 + Math.random() * 0.35 : 0.72 + Math.random() * 0.45;
        mesh.scale.set(maxScale, 0.05, maxScale);
        mesh.castShadow = true;
        spikeGroup.add(mesh);
        spikes.push({ mesh, maxScale });
    }
    scene.add(spikeGroup);
    transientVfx.push({
        mesh: spikeGroup,
        age: 0,
        duration: 0.62,
        update() {
            const t = this.age / this.duration;
            const pop = t < 0.2 ? t / 0.2 : 1;
            const sink = t > 0.55 ? (t - 0.55) / 0.45 : 0;
            const yScale = Math.max(0.05, pop * (1 - sink * 0.85));
            for (const s of spikes) {
                s.mesh.scale.set(s.maxScale, s.maxScale * yScale, s.maxScale);
                s.mesh.position.y = -55 + pop * 55 - sink * 85;
            }
            spikeMat.opacity = t > 0.65 ? Math.max(0, 1 - (t - 0.65) / 0.35) : 0.96;
        },
        onDispose() {
            spikeMat.dispose();
        }
    });
    for (let i = 0; i < 14; i++) {
        const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.3;
        const r = Math.random() * radius * 0.85;
        spawnSparkleParticle(x + Math.cos(angle) * r, 15 + Math.random() * 45, z + Math.sin(angle) * r, Math.cos(angle) * (40 + Math.random() * 75), 130 + Math.random() * 140, Math.sin(angle) * (40 + Math.random() * 75), eruptColor, 30 + Math.random() * 22, 0.38 + Math.random() * 0.22);
    }
}
export function spawnRingBurstVfx(x, z, colorHex, startR = 20, endR = 135, duration = 0.42) {
    const mat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const mesh = new THREE.Mesh(sharedRingBurstGeo, mat);
    mesh.position.set(x, 6, z);
    const baseScale = Math.max(1, startR);
    mesh.scale.setScalar(baseScale);
    scene.add(mesh);
    const scaleRatio = endR / baseScale;
    transientVfx.push({
        mesh,
        age: 0,
        duration,
        update() {
            const t = this.age / this.duration;
            const s = baseScale * (1 + (scaleRatio - 1) * (1 - Math.pow(1 - t, 2)));
            this.mesh.scale.setScalar(s);
            mat.opacity = 0.9 * (1 - t);
        },
        onDispose() {
            mat.dispose();
        }
    });
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
export function spawnMoveClickIndicator(x, z) {
    const { geo, tex } = getMoveArrowAssets();
    const group = new THREE.Group();
    group.position.set(x, 2, z);
    const mat = new THREE.MeshBasicMaterial({
        map: tex,
        color: 0xffffff,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
        depthWrite: false
    });
    const angles = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    for (const ang of angles) {
        const blade = new THREE.Mesh(geo, mat);
        blade.rotation.y = ang;
        group.add(blade);
    }
    scene.add(group);
    const duration = 0.34;
    transientVfx.push({
        mesh: group,
        age: 0,
        duration,
        update() {
            const t = this.age / this.duration;
            const ease = 1 - Math.pow(1 - t, 2);
            const s = 1.05 - 0.68 * ease;
            group.scale.setScalar(s);
            mat.opacity = t < 0.45 ? 0.96 : 0.96 * (1 - (t - 0.45) / 0.55);
        },
        onDispose() {
            mat.dispose();
        }
    });
}
function createSkybeamMesh(x, z, colorHex, width, height) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const mats = [];
    const angles = [0, Math.PI / 3, (2 * Math.PI) / 3];
    for (const ang of angles) {
        const mat = new THREE.MeshBasicMaterial({
            map: vfxTextures.skybeamGlow || undefined,
            color: colorHex,
            transparent: true,
            opacity: 0.92,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        const plane = new THREE.Mesh(sharedSkybeamGeo, mat);
        plane.scale.set(width, height, 1);
        plane.rotation.y = ang;
        group.add(plane);
        mats.push(mat);
    }
    return { group, mats };
}
function spawnSparkleParticle(x, y, z, vx, vy, vz, colorHex, size, duration) {
    const mat = new THREE.SpriteMaterial({
        map: vfxTextures.flashSpark || vfxTextures.healSparkles || undefined,
        color: colorHex,
        transparent: true,
        opacity: 1.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(x, y, z);
    sprite.scale.setScalar(size);
    scene.add(sprite);
    transientVfx.push({
        mesh: sprite,
        age: 0,
        duration,
        update(dt) {
            const t = this.age / this.duration;
            sprite.position.x += vx * dt;
            sprite.position.y += vy * dt;
            sprite.position.z += vz * dt;
            const pulse = 0.8 + 0.35 * Math.sin(this.age * 28);
            sprite.scale.setScalar(size * (1 - t * 0.55) * pulse);
            mat.opacity = Math.max(0, 1 - Math.pow(t, 1.5));
        },
        onDispose() {
            mat.dispose();
        }
    });
}
function spawnFlashBurstAtPoint(x, z, isDestination) {
    const beamWidth = isDestination ? 44 : 38;
    const beamHeight = isDestination ? 560 : 480;
    const { group: beamGroup, mats: beamMats } = createSkybeamMesh(x, z, 0xfff088, beamWidth, beamHeight);
    scene.add(beamGroup);
    transientVfx.push({
        mesh: beamGroup,
        age: 0,
        duration: 0.42,
        update() {
            const t = this.age / this.duration;
            const widthScale = Math.max(0.15, 1 - t * 0.75);
            beamGroup.scale.set(widthScale, 1 + t * 0.12, widthScale);
            for (const m of beamMats) {
                m.opacity = 0.95 * Math.pow(1 - t, 1.6);
            }
        },
        onDispose() {
            for (const m of beamMats)
                m.dispose();
        }
    });
    const burstGroup = new THREE.Group();
    burstGroup.position.set(x, 4, z);
    const haloMat = new THREE.MeshBasicMaterial({
        map: vfxTextures.flashHalo || vfxTextures.flashBurst || undefined,
        color: 0xffb82e,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    burstGroup.add(new THREE.Mesh(sharedFlashHaloGeo, haloMat));
    const starMat = new THREE.MeshBasicMaterial({
        map: vfxTextures.flashBurst || undefined,
        color: 0xfff59e,
        transparent: true,
        opacity: 0.98,
        blending: THREE.AdditiveBlending,
        depthWrite: false
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
    const burstMat1 = new THREE.MeshBasicMaterial({
        map: vfxTextures.flashBurst || undefined,
        color: 0x2eff5e,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const burstMesh1 = new THREE.Mesh(sharedHealBurst1Geo, burstMat1);
    healGroup.add(burstMesh1);
    const burstMat2 = new THREE.MeshBasicMaterial({
        map: vfxTextures.flashBurst || undefined,
        color: 0x7dffaa,
        transparent: true,
        opacity: 0.88,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const burstMesh2 = new THREE.Mesh(sharedHealBurst2Geo, burstMat2);
    burstMesh2.position.y = 2;
    healGroup.add(burstMesh2);
    const boltMat = new THREE.MeshBasicMaterial({
        map: vfxTextures.healBolts || vfxTextures.healWisps || undefined,
        color: 0x39ff7a,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
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
    const cylMat = new THREE.MeshBasicMaterial({
        map: vfxTextures.hasteShockwave || vfxTextures.ghostTrail || undefined,
        color: 0x22d8ff,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
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
export function spawnGhostTrailStep(x, z, facingAngle) {
    const backX = -Math.sin(facingAngle);
    const backZ = -Math.cos(facingAngle);
    const sideX = Math.cos(facingAngle);
    const sideZ = -Math.sin(facingAngle);
    const ribbonMat = new THREE.MeshBasicMaterial({
        map: vfxTextures.ghostTrail || vfxTextures.hasteShockwave || undefined,
        color: 0x24c8ff,
        transparent: true,
        opacity: 0.68,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const ribbon = new THREE.Mesh(sharedGhostRibbonGeo, ribbonMat);
    const lateralOffset = (Math.random() - 0.5) * 48;
    const heightOffset = 35 + Math.random() * 85;
    ribbon.position.set(x + backX * 28 + sideX * lateralOffset, heightOffset, z + backZ * 28 + sideZ * lateralOffset);
    ribbon.rotation.y = facingAngle + Math.PI / 2;
    ribbon.rotation.z = (Math.random() - 0.5) * 0.35;
    scene.add(ribbon);
    transientVfx.push({
        mesh: ribbon,
        age: 0,
        duration: 0.36,
        update(dt) {
            const t = this.age / this.duration;
            ribbon.position.x += backX * 95 * dt;
            ribbon.position.z += backZ * 95 * dt;
            ribbon.scale.set(1 + t * 0.45, Math.max(0.2, 1 - t * 0.6), 1);
            ribbonMat.opacity = 0.68 * (1 - t);
        },
        onDispose() {
            ribbonMat.dispose();
        }
    });
    const isGreenOrb = Math.random() < 0.62;
    const orbMat = new THREE.SpriteMaterial({
        map: vfxTextures.flashHalo || vfxTextures.flashSpark || undefined,
        color: isGreenOrb ? 0x22ff68 : 0x1ec8ff,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const orb = new THREE.Sprite(orbMat);
    const orbLat = (Math.random() - 0.5) * 44;
    orb.position.set(x + backX * 36 + sideX * orbLat, 65 + Math.random() * 65, z + backZ * 36 + sideZ * orbLat);
    const startScale = isGreenOrb ? 54 : 42;
    orb.scale.setScalar(startScale);
    scene.add(orb);
    transientVfx.push({
        mesh: orb,
        age: 0,
        duration: 0.44,
        update(dt) {
            const t = this.age / this.duration;
            orb.position.x += backX * 70 * dt;
            orb.position.y += 18 * dt;
            orb.position.z += backZ * 70 * dt;
            orb.scale.setScalar(startScale * (1 - t * 0.45));
            orbMat.opacity = 0.72 * Math.pow(1 - t, 1.3);
        },
        onDispose() {
            orbMat.dispose();
        }
    });
}
export function updateTransientVfx(dt) {
    for (let i = transientVfx.length - 1; i >= 0; i--) {
        const vfx = transientVfx[i];
        vfx.age += dt;
        if (vfx.age >= vfx.duration) {
            scene.remove(vfx.mesh);
            vfx.onDispose?.();
            transientVfx.splice(i, 1);
        }
        else {
            vfx.update(dt);
        }
    }
}
// ============================================================================
// DYNAMIC SKILLSHOT INDICATOR (LINE OR GROUND AOE CIRCLE PER CHAMPION)
// ============================================================================
const lineIndicatorGroup = new THREE.Group();
lineIndicatorGroup.visible = false;
scene.add(lineIndicatorGroup);
const lineIndicatorMat = new THREE.MeshBasicMaterial({
    color: 0x0ac8b9,
    transparent: true,
    opacity: 0.32,
    side: THREE.DoubleSide,
    depthWrite: false
});
const lineGeoCache = new Map();
const lineIndicatorMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lineIndicatorMat);
lineIndicatorMesh.position.y = 4;
lineIndicatorGroup.add(lineIndicatorMesh);
const circleRangeRingGeo = new THREE.RingGeometry(0.985, 1.0, 64);
circleRangeRingGeo.rotateX(-Math.PI / 2);
const circleRangeRingMat = new THREE.MeshBasicMaterial({
    color: 0x0ac8b9,
    transparent: true,
    opacity: 0.38,
    side: THREE.DoubleSide,
    depthWrite: false
});
const circleRangeMesh = new THREE.Mesh(circleRangeRingGeo, circleRangeRingMat);
circleRangeMesh.visible = false;
circleRangeMesh.position.y = 3;
scene.add(circleRangeMesh);
const circleTargetGroup = new THREE.Group();
circleTargetGroup.visible = false;
scene.add(circleTargetGroup);
const circleTargetFillMat = new THREE.MeshBasicMaterial({
    color: 0xb833ff,
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
    depthWrite: false
});
const circleTargetFill = new THREE.Mesh(sharedZoneFillGeo, circleTargetFillMat);
circleTargetFill.position.y = 4;
circleTargetGroup.add(circleTargetFill);
const circleTargetRimMat = new THREE.MeshBasicMaterial({
    color: 0xd980ff,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false
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
    // Circular ground AoE indicator clamped to ability range
    lineIndicatorGroup.visible = false;
    circleRangeMesh.visible = true;
    circleRangeMesh.position.set(myPlayer.x, 3, myPlayer.z);
    circleRangeMesh.scale.setScalar(ind.range);
    circleRangeRingMat.color.setHex(ind.colorHex);
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
    circleTargetRimMat.color.setHex(ind.colorHex);
}
