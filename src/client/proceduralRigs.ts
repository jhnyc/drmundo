import * as THREE from 'three';

export interface ProceduralRigInstance {
  group: THREE.Group;
  bodyMaterials: THREE.MeshStandardMaterial[];
  animate(animKey: string, dt: number, elapsed: number, castElapsed: number): void;
}

function buildChogathVoidBeastRig(scale: number): ProceduralRigInstance {
  const group = new THREE.Group();
  const bodyMaterials: THREE.MeshStandardMaterial[] = [];

  const armorMat = new THREE.MeshStandardMaterial({
    color: 0x3b1854,
    roughness: 0.42,
    metalness: 0.25,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0
  });
  const fleshMat = new THREE.MeshStandardMaterial({
    color: 0x8d1f3c,
    roughness: 0.55,
    metalness: 0.1,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0
  });
  const spikeMat = new THREE.MeshStandardMaterial({
    color: 0x1a0b24,
    roughness: 0.35,
    metalness: 0.4,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xffe46b,
    emissive: new THREE.Color(0xff9d00),
    emissiveIntensity: 1.35,
    roughness: 0.2
  });
  bodyMaterials.push(armorMat, fleshMat, spikeMat);

  const torsoPivot = new THREE.Group();
  torsoPivot.position.y = 74;
  group.add(torsoPivot);

  // Armored void chest
  const chest = new THREE.Mesh(new THREE.DodecahedronGeometry(46, 1), armorMat);
  chest.scale.set(1.15, 1.05, 0.95);
  chest.castShadow = true;
  chest.receiveShadow = true;
  torsoPivot.add(chest);

  // Inner crimson belly core
  const belly = new THREE.Mesh(new THREE.SphereGeometry(36, 14, 12), fleshMat);
  belly.position.set(0, -14, 12);
  belly.scale.set(1.05, 0.9, 0.95);
  belly.castShadow = true;
  torsoPivot.add(belly);

  // Jagged dorsal Void carapace spikes
  const dorsalGeo = new THREE.ConeGeometry(9, 44, 5);
  const dorsalOffsets: Array<[number, number, number, number, number]> = [
    [-16, 36, -24, -0.45, 0.2],
    [16, 36, -24, -0.45, -0.2],
    [-22, 18, -38, -0.75, 0.25],
    [22, 18, -38, -0.75, -0.25],
    [0, 44, -12, -0.25, 0]
  ];
  for (const [x, y, z, rx, rz] of dorsalOffsets) {
    const spike = new THREE.Mesh(dorsalGeo, spikeMat);
    spike.position.set(x, y, z);
    spike.rotation.set(rx, 0, rz);
    spike.castShadow = true;
    torsoPivot.add(spike);
  }

  // Head + monstrous jaw & glowing eyes
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 26, 34);
  torsoPivot.add(headPivot);

  const cranium = new THREE.Mesh(new THREE.DodecahedronGeometry(26, 0), armorMat);
  cranium.scale.set(1.1, 0.85, 1.25);
  cranium.castShadow = true;
  headPivot.add(cranium);

  const jaw = new THREE.Mesh(new THREE.BoxGeometry(34, 12, 34), fleshMat);
  jaw.position.set(0, -12, 6);
  jaw.castShadow = true;
  headPivot.add(jaw);

  // Mandible horns
  const hornGeo = new THREE.ConeGeometry(5.5, 28, 5);
  for (const side of [-1, 1]) {
    const horn = new THREE.Mesh(hornGeo, spikeMat);
    horn.position.set(side * 20, 4, 16);
    horn.rotation.set(Math.PI * 0.42, 0, -side * 0.32);
    horn.castShadow = true;
    headPivot.add(horn);

    const eye = new THREE.Mesh(new THREE.SphereGeometry(4.2, 8, 8), eyeMat);
    eye.position.set(side * 13, 6, 22);
    headPivot.add(eye);
  }

  // Twin giant scythe forearms + secondary raptor claws
  const armGeo = new THREE.BoxGeometry(16, 52, 18);
  const clawGeo = new THREE.ConeGeometry(8, 38, 4);
  const arms: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const armPivot = new THREE.Group();
    armPivot.position.set(side * 52, 14, 8);

    const shoulder = new THREE.Mesh(new THREE.DodecahedronGeometry(18, 0), armorMat);
    shoulder.castShadow = true;
    armPivot.add(shoulder);

    const forearm = new THREE.Mesh(armGeo, fleshMat);
    forearm.position.set(side * 4, -26, 10);
    forearm.rotation.x = -0.45;
    forearm.castShadow = true;
    armPivot.add(forearm);

    const scythe = new THREE.Mesh(clawGeo, spikeMat);
    scythe.position.set(side * 6, -54, 24);
    scythe.rotation.x = Math.PI * 0.72;
    scythe.castShadow = true;
    armPivot.add(scythe);

    torsoPivot.add(armPivot);
    arms.push(armPivot);
  }

  // Spiked tail
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, -18, -36);
  const tailMesh = new THREE.Mesh(new THREE.ConeGeometry(16, 68, 6), armorMat);
  tailMesh.rotation.x = -Math.PI * 0.58;
  tailMesh.position.set(0, -6, -28);
  tailMesh.castShadow = true;
  tailPivot.add(tailMesh);
  torsoPivot.add(tailPivot);

  // Heavy stomping legs
  const legGeo = new THREE.CylinderGeometry(14, 19, 58, 7);
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const legPivot = new THREE.Group();
    legPivot.position.set(side * 28, 56, 0);
    const legMesh = new THREE.Mesh(legGeo, armorMat);
    legMesh.position.y = -28;
    legMesh.castShadow = true;
    legPivot.add(legMesh);
    group.add(legPivot);
    legs.push(legPivot);
  }

  group.scale.setScalar(scale);

  return {
    group,
    bodyMaterials,
    animate(animKey: string, _dt: number, elapsed: number, castElapsed: number) {
      if (animKey === 'death') {
        torsoPivot.position.y = 26;
        torsoPivot.rotation.x = 1.25;
        torsoPivot.rotation.z = 0.25;
        headPivot.rotation.x = 0.3;
        arms[0].rotation.x = -0.4;
        arms[1].rotation.x = -0.4;
        legs[0].rotation.x = -0.8;
        legs[1].rotation.x = -0.6;
        return;
      }

      if (animKey === 'q_cast') {
        // Stomp slam animation: wind up high, then smash foot & claws down
        const p = Math.min(1, castElapsed / 0.25);
        const slam = p < 0.45 ? -p / 0.45 : (p - 0.45) / 0.55;
        torsoPivot.position.y = p < 0.45 ? 74 + 22 * Math.abs(slam) : 74 - 16 * slam;
        torsoPivot.rotation.x = p < 0.45 ? -0.28 * Math.abs(slam) : 0.35 * slam;
        arms[0].rotation.x = p < 0.45 ? -1.1 * Math.abs(slam) : 0.4 * slam;
        arms[1].rotation.x = p < 0.45 ? -1.1 * Math.abs(slam) : 0.4 * slam;
        legs[0].rotation.x = p < 0.45 ? -0.75 * Math.abs(slam) : 0.25 * slam;
        legs[1].rotation.x = 0.15;
        headPivot.rotation.x = p < 0.45 ? -0.2 : 0.25;
        return;
      }

      if (animKey === 'run' || animKey === 'run_haste') {
        const freq = animKey === 'run_haste' ? 14 : 9.5;
        const stride = Math.sin(elapsed * freq);
        torsoPivot.position.y = 74 + Math.abs(stride) * 7;
        torsoPivot.rotation.x = 0.18;
        torsoPivot.rotation.z = stride * 0.08;
        legs[0].rotation.x = stride * 0.65;
        legs[1].rotation.x = -stride * 0.65;
        arms[0].rotation.x = -stride * 0.48 - 0.2;
        arms[1].rotation.x = stride * 0.48 - 0.2;
        tailPivot.rotation.y = stride * 0.25;
        headPivot.rotation.x = -0.06;
        return;
      }

      if (animKey === 'taunt' || animKey === 'laugh' || animKey === 'dance') {
        const bounce = Math.sin(elapsed * 8);
        torsoPivot.position.y = 74 + Math.abs(bounce) * 10;
        torsoPivot.rotation.x = -0.18 + bounce * 0.12;
        torsoPivot.rotation.z = animKey === 'dance' ? Math.sin(elapsed * 4) * 0.22 : 0;
        arms[0].rotation.x = -0.85 + bounce * 0.35;
        arms[1].rotation.x = -0.85 - bounce * 0.35;
        legs[0].rotation.x = 0;
        legs[1].rotation.x = 0;
        headPivot.rotation.x = -0.25 + Math.sin(elapsed * 14) * 0.08;
        return;
      }

      // Idle breathing
      const breath = Math.sin(elapsed * 2.6);
      torsoPivot.position.y = 74 + breath * 3.5;
      torsoPivot.rotation.x = 0.06 + breath * 0.03;
      torsoPivot.rotation.z = 0;
      headPivot.rotation.x = Math.sin(elapsed * 1.8) * 0.06;
      arms[0].rotation.x = -0.15 + breath * 0.08;
      arms[1].rotation.x = -0.15 + breath * 0.08;
      legs[0].rotation.x = 0;
      legs[1].rotation.x = 0;
      tailPivot.rotation.y = Math.sin(elapsed * 2.1) * 0.18;
    }
  };
}

export function buildProceduralChampionRig(
  preset: 'chogath_void_beast',
  scale: number
): ProceduralRigInstance {
  switch (preset) {
    case 'chogath_void_beast':
    default:
      return buildChogathVoidBeastRig(scale);
  }
}
