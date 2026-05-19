/**
 * react-native-device-info's web shim assumes BatteryManager always implements
 * addEventListener. Chrome can expose navigator.getBattery() in environments
 * where the returned object only supports onchargingchange/onlevelchange.
 */
const fs = require('fs');
const path = require('path');

let patched = 0;

const nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
];

const files = [
    'react-native-device-info/lib/module/web/index.js',
    'react-native-device-info/lib/commonjs/web/index.js',
    'react-native-device-info/src/web/index.js',
];

const helper = `
const addBatteryListener = (battery, type, listener) => {
  if (typeof battery.addEventListener === 'function') {
    battery.addEventListener(type, listener);
    return;
  }
  battery[\`on\${type}\`] = listener;
};
`;

for (const nodeModulesRoot of nodeModulesRoots) {
    for (const file of files) {
        const filePath = path.join(nodeModulesRoot, file);
        if (!fs.existsSync(filePath)) continue;

        let content = fs.readFileSync(filePath, 'utf8');
        const original = content;

        if (!content.includes('const addBatteryListener = ')) {
            content = content.replace(
                'const _readPowerState = battery => {',
                `${helper}\nconst _readPowerState = battery => {`
            );
            content = content.replace(
                'const _readPowerState = (battery) => {',
                `${helper}\nconst _readPowerState = (battery) => {`
            );
        }

        content = content.replace(
            /battery\.addEventListener\('chargingchange', \(\) => \{/g,
            "addBatteryListener(battery, 'chargingchange', () => {"
        );
        content = content.replace(
            /battery\.addEventListener\('levelchange', \(\) => \{/g,
            "addBatteryListener(battery, 'levelchange', () => {"
        );

        if (content !== original) {
            fs.writeFileSync(filePath, content, 'utf8');
            patched++;
        }
    }
}

if (patched > 0) {
    console.log(`[patch] Fixed react-native-device-info web listener fallback (${patched} file(s))`);
}
