/**
 * Expo Battery's web shim assumes BatteryManager always implements
 * addEventListener/removeEventListener. Some browser implementations expose
 * only onchargingchange/onlevelchange handler properties, which crashes the web
 * app during battery observation.
 */
const fs = require('fs');
const path = require('path');

let patched = 0;

const nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
];

const replacements = [
    {
        file: 'expo-battery/build/ExpoBattery.web.js',
        patches: [
            [
                "        batteryManager.addEventListener('chargingchange', onChargingChange);\n        batteryManager.addEventListener('levelchange', onLevelChange);",
                "        addBatteryListener(batteryManager, 'chargingchange', onChargingChange);\n        addBatteryListener(batteryManager, 'levelchange', onLevelChange);",
            ],
            [
                "        batteryManager.removeEventListener('chargingchange', onChargingChange);\n        batteryManager.removeEventListener('levelchange', onLevelChange);",
                "        removeBatteryListener(batteryManager, 'chargingchange', onChargingChange);\n        removeBatteryListener(batteryManager, 'levelchange', onLevelChange);",
            ],
            [
                "function onLevelChange() {\n    const batteryLevel = this.level;\n    // update the state as well in case the state changed to full.\n    emitStateChange(this.charging, this.level);\n    emitter.emit('Expo.batteryLevelDidChange', { batteryLevel });\n}\nasync function getBatteryManagerAsync() {",
                "function onLevelChange() {\n    const batteryLevel = this.level;\n    // update the state as well in case the state changed to full.\n    emitStateChange(this.charging, this.level);\n    emitter.emit('Expo.batteryLevelDidChange', { batteryLevel });\n}\nfunction addBatteryListener(batteryManager, type, listener) {\n    if (typeof batteryManager.addEventListener === 'function') {\n        batteryManager.addEventListener(type, listener);\n        return;\n    }\n    batteryManager[`on${type}`] = listener.bind(batteryManager);\n}\nfunction removeBatteryListener(batteryManager, type, listener) {\n    if (typeof batteryManager.removeEventListener === 'function') {\n        batteryManager.removeEventListener(type, listener);\n        return;\n    }\n    batteryManager[`on${type}`] = null;\n}\nasync function getBatteryManagerAsync() {",
            ],
        ],
    },
    {
        file: 'expo-battery/src/ExpoBattery.web.ts',
        patches: [
            [
                "    batteryManager.addEventListener('chargingchange', onChargingChange);\n    batteryManager.addEventListener('levelchange', onLevelChange);",
                "    addBatteryListener(batteryManager, 'chargingchange', onChargingChange);\n    addBatteryListener(batteryManager, 'levelchange', onLevelChange);",
            ],
            [
                "    batteryManager.removeEventListener('chargingchange', onChargingChange);\n    batteryManager.removeEventListener('levelchange', onLevelChange);",
                "    removeBatteryListener(batteryManager, 'chargingchange', onChargingChange);\n    removeBatteryListener(batteryManager, 'levelchange', onLevelChange);",
            ],
            [
                "function onLevelChange(this: BatteryManager): void {\n  const batteryLevel = this.level;\n  // update the state as well in case the state changed to full.\n  emitStateChange(this.charging, this.level);\n  emitter.emit('Expo.batteryLevelDidChange', { batteryLevel });\n}\n\nasync function getBatteryManagerAsync(): Promise<BatteryManager | null> {",
                "function onLevelChange(this: BatteryManager): void {\n  const batteryLevel = this.level;\n  // update the state as well in case the state changed to full.\n  emitStateChange(this.charging, this.level);\n  emitter.emit('Expo.batteryLevelDidChange', { batteryLevel });\n}\n\nfunction addBatteryListener<K extends keyof BatteryManagerEventTargetEventMap>(\n  batteryManager: BatteryManager,\n  type: K,\n  listener: (this: BatteryManager, ev: BatteryManagerEventTargetEventMap[K]) => any\n): void {\n  if (typeof batteryManager.addEventListener === 'function') {\n    batteryManager.addEventListener(type, listener);\n    return;\n  }\n  batteryManager[`on${type}`] = listener.bind(batteryManager);\n}\n\nfunction removeBatteryListener<K extends keyof BatteryManagerEventTargetEventMap>(\n  batteryManager: BatteryManager,\n  type: K,\n  listener: (this: BatteryManager, ev: BatteryManagerEventTargetEventMap[K]) => any\n): void {\n  if (typeof batteryManager.removeEventListener === 'function') {\n    batteryManager.removeEventListener(type, listener);\n    return;\n  }\n  batteryManager[`on${type}`] = null;\n}\n\nasync function getBatteryManagerAsync(): Promise<BatteryManager | null> {",
            ],
        ],
    },
];

for (const nodeModulesRoot of nodeModulesRoots) {
    for (const replacement of replacements) {
        const filePath = path.join(nodeModulesRoot, replacement.file);
        if (!fs.existsSync(filePath)) continue;

        let content = fs.readFileSync(filePath, 'utf8');
        const original = content;
        for (const [from, to] of replacement.patches) {
            if (content.includes(from)) {
                content = content.replace(from, to);
            }
        }

        if (content !== original) {
            fs.writeFileSync(filePath, content, 'utf8');
            patched++;
        }
    }
}

if (patched > 0) {
    console.log(`[patch] Fixed expo-battery web listener fallback (${patched} file(s))`);
}
