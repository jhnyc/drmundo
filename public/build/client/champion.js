import * as THREE from 'three';
import { DEFAULT_CHAMPION_ID, getChampionConfig } from '../shared/champions/index.js';
import { buildProceduralChampionRig } from './proceduralRigs.js';
import { gltfLoader, objLoader, scene, textureLoader } from './scene.js';
const _pelvisWorld = new THREE.Vector3();
export class ChampionRig {
    slot;
    root;
    championId = null;
    config;
    model = null;
    pelvisNode = null;
    mixer = null;
    clips = new Map();
    activeAction = null;
    currentAnimKey = '';
    castHiddenMesh = null;
    castHideTimer = 0;
    loadToken = 0;
    proceduralRig = null;
    animElapsed = 0;
    castAnimTimer = 0;
    shadowDisc;
    bodyMaterials = [];
    flashTintTimer = 0;
    healTintTimer = 0;
    ghostTrailEmitTimer = 0;
    lastEmissiveHex = -1;
    lastEmissiveInt = -1;
    lastBodyOpacity = -1;
    constructor(slot, initialChampionId = DEFAULT_CHAMPION_ID) {
        this.slot = slot;
        this.config = getChampionConfig(initialChampionId);
        this.root = new THREE.Group();
        scene.add(this.root);
        const shadowGeo = new THREE.CircleGeometry(52, 32);
        shadowGeo.rotateX(-Math.PI / 2);
        const shadowMat = new THREE.MeshBasicMaterial({
            color: 0x000000,
            transparent: true,
            opacity: 0.42,
            depthWrite: false
        });
        this.shadowDisc = new THREE.Mesh(shadowGeo, shadowMat);
        this.shadowDisc.position.y = 1.5;
        this.root.add(this.shadowDisc);
        if (slot === 0) {
            this.root.position.set(-300, 0, -300);
            this.root.rotation.y = Math.PI * 0.25;
        }
        else {
            this.root.position.set(300, 0, 300);
            this.root.rotation.y = -Math.PI * 0.75;
        }
    }
    clearCurrentModel() {
        if (this.mixer) {
            this.mixer.stopAllAction();
            this.mixer = null;
        }
        this.clips.clear();
        this.activeAction = null;
        this.currentAnimKey = '';
        this.pelvisNode = null;
        this.castHiddenMesh = null;
        this.proceduralRig = null;
        this.bodyMaterials = [];
        this.lastEmissiveHex = -1;
        this.lastEmissiveInt = -1;
        this.lastBodyOpacity = -1;
        if (this.model) {
            this.root.remove(this.model);
            this.model = null;
        }
    }
    async load(championId = this.config.id) {
        if (this.championId === championId && this.model)
            return;
        const token = ++this.loadToken;
        this.championId = championId;
        this.config = getChampionConfig(championId);
        const modelCfg = this.config.model;
        const shadowScale = Math.max(0.8, this.config.stats.hitboxRadius / 65);
        this.shadowDisc.scale.setScalar(shadowScale);
        if (modelCfg.kind === 'procedural') {
            this.clearCurrentModel();
            const proc = buildProceduralChampionRig(modelCfg.preset, modelCfg.scale);
            this.proceduralRig = proc;
            this.model = proc.group;
            this.bodyMaterials = proc.bodyMaterials;
            this.root.add(this.model);
            this.playAnim('idle', true);
            return;
        }
        const gltf = await gltfLoader.loadAsync(modelCfg.url);
        if (token !== this.loadToken)
            return;
        this.clearCurrentModel();
        this.model = gltf.scene;
        this.model.scale.setScalar(modelCfg.scale);
        this.model.position.set(0, 0, 0);
        for (const boneName of modelCfg.pelvisBones) {
            const node = this.model.getObjectByName(boneName);
            if (node) {
                this.pelvisNode = node;
                break;
            }
        }
        const hideCfg = modelCfg.castMeshHide;
        this.model.traverse((child) => {
            if (child.isMesh) {
                const mesh = child;
                mesh.frustumCulled = false;
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                if (mesh.material && !Array.isArray(mesh.material)) {
                    const mat = mesh.material.clone();
                    mat.side = THREE.DoubleSide;
                    mesh.material = mat;
                    const ud = (mat.userData || {});
                    if (ud.visible === false) {
                        mesh.visible = false;
                    }
                    else {
                        mesh.visible = true;
                        this.bodyMaterials.push(mat);
                    }
                    if (hideCfg &&
                        (mat.name === hideCfg.materialName ||
                            (hideCfg.materialHash !== undefined && ud.hash === hideCfg.materialHash))) {
                        this.castHiddenMesh = mesh;
                    }
                }
            }
        });
        this.root.add(this.model);
        this.mixer = new THREE.AnimationMixer(this.model);
        for (const clip of gltf.animations) {
            this.clips.set(clip.name, clip);
        }
        this.playAnim('idle', true);
    }
    playAnim(animKey, forceRestart = false) {
        if (this.currentAnimKey === animKey && !forceRestart)
            return;
        if (this.proceduralRig) {
            this.currentAnimKey = animKey;
            if (animKey === 'q_cast') {
                this.castAnimTimer = 0;
            }
            return;
        }
        if (!this.mixer || this.config.model.kind !== 'glb')
            return;
        const clipCfg = this.config.model.clips[animKey] || this.config.model.clips.idle;
        const clip = this.clips.get(clipCfg.clipName) ||
            (clipCfg.fallbackClipName ? this.clips.get(clipCfg.fallbackClipName) : undefined) ||
            this.clips.values().next().value;
        if (!clip)
            return;
        this.currentAnimKey = animKey;
        const nextAction = this.mixer.clipAction(clip);
        nextAction.reset();
        if (clipCfg.loop === 'once') {
            nextAction.setLoop(THREE.LoopOnce, 1);
            nextAction.clampWhenFinished = Boolean(clipCfg.clampWhenFinished ?? true);
        }
        else {
            nextAction.setLoop(THREE.LoopRepeat, Infinity);
        }
        nextAction.timeScale = clipCfg.timeScale ?? 1.0;
        if (this.activeAction && this.activeAction !== nextAction) {
            nextAction.crossFadeFrom(this.activeAction, 0.12, false);
        }
        nextAction.play();
        this.activeAction = nextAction;
    }
    triggerCastVisual() {
        this.playAnim('q_cast', true);
        this.castAnimTimer = 0;
        if (this.config.model.kind === 'glb' && this.config.model.castMeshHide) {
            this.castHideTimer = this.config.model.castMeshHide.totalDuration;
        }
        else {
            this.castHideTimer = Math.max(0.28, this.config.q.castTime);
        }
    }
    triggerFlashBlink(toX, toZ) {
        this.root.position.x = toX;
        this.root.position.z = toZ;
        this.flashTintTimer = 0.3;
    }
    triggerHealOverlay() {
        this.healTintTimer = 0.55;
    }
    update(dt, serverPlayer, onGhostTrailStep) {
        this.animElapsed += dt;
        if (this.currentAnimKey === 'q_cast') {
            this.castAnimTimer += dt;
        }
        if (serverPlayer?.championId && serverPlayer.championId !== this.championId) {
            void this.load(serverPlayer.championId);
        }
        if (this.mixer) {
            this.mixer.update(dt);
        }
        const hideCfg = this.config.model.kind === 'glb' ? this.config.model.castMeshHide : undefined;
        if (this.castHideTimer > 0) {
            this.castHideTimer = Math.max(0, this.castHideTimer - dt);
        }
        if (this.castHiddenMesh && hideCfg) {
            if (this.castHideTimer > 0) {
                this.castHiddenMesh.visible = this.castHideTimer > hideCfg.visibleBeforeRemaining;
            }
            else {
                this.castHiddenMesh.visible = true;
            }
        }
        if (this.flashTintTimer > 0)
            this.flashTintTimer = Math.max(0, this.flashTintTimer - dt);
        if (this.healTintTimer > 0)
            this.healTintTimer = Math.max(0, this.healTintTimer - dt);
        if (!serverPlayer) {
            this.root.visible = false;
            return;
        }
        this.root.visible = true;
        const lerpFactor = Math.min(1, dt * 22);
        this.root.position.x += (serverPlayer.x - this.root.position.x) * lerpFactor;
        this.root.position.z += (serverPlayer.z - this.root.position.z) * lerpFactor;
        const diffAngle = Math.atan2(Math.sin(serverPlayer.angle - this.root.rotation.y), Math.cos(serverPlayer.angle - this.root.rotation.y));
        this.root.rotation.y += diffAngle * Math.min(1, dt * 18);
        if (this.model && this.pelvisNode && this.config.model.kind === 'glb') {
            this.root.updateMatrixWorld(true);
            this.pelvisNode.getWorldPosition(_pelvisWorld);
            this.root.worldToLocal(_pelvisWorld);
            const factor = this.config.model.pelvisRootMotionFactor;
            this.model.position.x -= _pelvisWorld.x * factor;
            this.model.position.z -= _pelvisWorld.z * factor;
        }
        // Airborne knockup arc (applies cleanly to both GLB & procedural champions)
        const knockupTimer = serverPlayer.knockupTimer ?? 0;
        const knockupDuration = serverPlayer.knockupDuration ?? 0;
        const baseShadowScale = Math.max(0.8, this.config.stats.hitboxRadius / 65);
        if (this.model) {
            if (knockupTimer > 0 && knockupDuration > 0) {
                const progress = Math.max(0, Math.min(1, 1 - knockupTimer / knockupDuration));
                const arcY = Math.sin(progress * Math.PI) * 155;
                this.model.position.y = arcY;
                this.shadowDisc.scale.setScalar(baseShadowScale * (1 - 0.35 * Math.sin(progress * Math.PI)));
            }
            else {
                this.model.position.y = 0;
                this.shadowDisc.scale.setScalar(baseShadowScale);
            }
        }
        const lockRemaining = hideCfg ? hideCfg.lockAnimUntilRemaining : 0.05;
        if (this.currentAnimKey === 'q_cast' && this.castHideTimer > lockRemaining) {
            // Allow Q cast animation to play through release
        }
        else {
            this.playAnim(serverPlayer.anim || 'idle');
        }
        if (this.proceduralRig) {
            this.proceduralRig.animate(this.currentAnimKey || 'idle', dt, this.animElapsed, this.castAnimTimer);
        }
        let emissiveHex = 0x000000;
        let emissiveInt = 0.0;
        let bodyOpacity = 1.0;
        if (this.flashTintTimer > 0) {
            emissiveHex = 0xffaa1d;
            emissiveInt = (this.flashTintTimer / 0.3) * 1.65;
        }
        else if (this.healTintTimer > 0) {
            emissiveHex = 0x26e658;
            emissiveInt = (this.healTintTimer / 0.55) * 1.15;
        }
        else if (serverPlayer.ghostTimer > 0) {
            emissiveHex = 0x16a8ff;
            emissiveInt = 0.52 + Math.sin(performance.now() * 0.014) * 0.14;
            bodyOpacity = 0.86;
        }
        else if (serverPlayer.slowTimer > 0) {
            emissiveHex = 0x5c2d91;
            emissiveInt = 0.32;
        }
        if (emissiveHex !== this.lastEmissiveHex ||
            Math.abs(emissiveInt - this.lastEmissiveInt) > 0.005 ||
            bodyOpacity !== this.lastBodyOpacity) {
            this.lastEmissiveHex = emissiveHex;
            this.lastEmissiveInt = emissiveInt;
            this.lastBodyOpacity = bodyOpacity;
            for (const mat of this.bodyMaterials) {
                if (mat.emissive) {
                    mat.emissive.setHex(emissiveHex);
                    mat.emissiveIntensity = emissiveInt;
                }
                if (bodyOpacity < 0.99) {
                    mat.transparent = true;
                    mat.opacity = bodyOpacity;
                }
                else {
                    mat.transparent = false;
                    mat.opacity = 1.0;
                }
            }
        }
        if (serverPlayer.ghostTimer > 0) {
            this.ghostTrailEmitTimer -= dt;
            if (this.ghostTrailEmitTimer <= 0) {
                this.ghostTrailEmitTimer = 0.042;
                onGhostTrailStep?.(this.root.position.x, this.root.position.z, this.root.rotation.y);
            }
        }
        else {
            this.ghostTrailEmitTimer = 0;
        }
    }
}
export const championRigs = [
    new ChampionRig(0, DEFAULT_CHAMPION_ID),
    new ChampionRig(1, DEFAULT_CHAMPION_ID)
];
const projectileTemplateCache = new Map();
const projectileLoadingPromises = new Map();
export function getCachedProjectileTemplate(championId) {
    const champ = getChampionConfig(championId);
    if (champ.q.archetype !== 'linear_projectile')
        return null;
    if (champ.q.projectileVisual.kind !== 'obj_model')
        return null;
    const key = `${champ.q.projectileVisual.objUrl}|${champ.q.projectileVisual.textureUrl}`;
    const cached = projectileTemplateCache.get(key);
    if (!cached) {
        void loadProjectileTemplate(champ.q.projectileVisual);
        return null;
    }
    return cached;
}
export async function loadProjectileTemplate(visual) {
    if (visual.kind !== 'obj_model')
        return null;
    const key = `${visual.objUrl}|${visual.textureUrl}`;
    const existing = projectileTemplateCache.get(key);
    if (existing)
        return existing;
    const inflight = projectileLoadingPromises.get(key);
    if (inflight)
        return inflight;
    const promise = (async () => {
        try {
            const [weaponObj, weaponTex] = await Promise.all([
                objLoader.loadAsync(visual.objUrl),
                textureLoader.loadAsync(visual.textureUrl)
            ]);
            weaponTex.colorSpace = THREE.SRGBColorSpace;
            const group = new THREE.Group();
            weaponObj.traverse((child) => {
                if (child.isMesh) {
                    const mesh = child;
                    mesh.geometry.center();
                    mesh.material = new THREE.MeshStandardMaterial({
                        map: weaponTex,
                        roughness: 0.3,
                        metalness: 0.55,
                        emissive: new THREE.Color(visual.emissiveHex),
                        emissiveIntensity: visual.emissiveIntensity,
                        side: THREE.DoubleSide
                    });
                    mesh.castShadow = true;
                }
            });
            weaponObj.scale.setScalar(visual.scale);
            group.add(weaponObj);
            projectileTemplateCache.set(key, group);
            return group;
        }
        catch {
            return null;
        }
        finally {
            projectileLoadingPromises.delete(key);
        }
    })();
    projectileLoadingPromises.set(key, promise);
    return promise;
}
