const assert = require("node:assert/strict");
const { validateRelease } = require("../.github/scripts/validate-release.cjs");

function metadata(version = "0.7.0") {
  return [
    { version },
    { version },
    { version, packages: { "": { version } } },
  ];
}

assert.equal(validateRelease(...metadata(), "branch", "main"), "0.7.0");
assert.equal(validateRelease(...metadata(), "branch", "0.8.0"), "0.7.0");
assert.equal(validateRelease(...metadata()), "0.7.0");
assert.equal(validateRelease(...metadata(), "tag", "0.7.0"), "0.7.0");
assert.equal(validateRelease(...metadata("1.20.300"), "tag", "1.20.300"), "1.20.300");

for (const tag of ["v0.7.0", "0.8.0", "0.7.0-beta.1", "", undefined]) {
  assert.throws(() => validateRelease(...metadata(), "tag", tag), /tag must exactly match/);
}

for (const version of ["v0.7.0", "0.7", "0.7.0-beta.1", "0.7.0+build.1", "01.7.0", "0.07.0", "0.7.00", "0.7.0\n", ""]) {
  assert.throws(() => validateRelease(...metadata(version)), /version must/);
}

for (const version of [null, 7]) {
  assert.throws(() => validateRelease(...metadata(version)), /must contain a version/);
}

const missingVersion = metadata();
delete missingVersion[0].version;
assert.throws(() => validateRelease(...missingVersion), /must contain a version/);

const packageMismatch = metadata();
packageMismatch[1].version = "0.8.0";
assert.throws(() => validateRelease(...packageMismatch), /package.json and manifest.json/);

const lockMismatch = metadata();
lockMismatch[2].version = "0.8.0";
assert.throws(() => validateRelease(...lockMismatch), /package-lock.json and manifest.json/);

const rootMismatch = metadata();
rootMismatch[2].packages[""].version = "0.8.0";
assert.throws(() => validateRelease(...rootMismatch), /root package version/);

const missingRoot = metadata();
delete missingRoot[2].packages;
assert.throws(() => validateRelease(...missingRoot), /root package version/);

console.log("release validation tests passed");
