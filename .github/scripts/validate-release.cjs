const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

function validateRelease(manifest, pkg, lock, refType, refName) {
  assert.equal(typeof manifest.version, "string", "manifest.json must contain a version");
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    "The plugin version must use the Obsidian x.y.z format (no v prefix or prerelease suffix)");
  assert.equal(pkg.version, manifest.version, "package.json and manifest.json versions must match");
  assert.equal(lock.version, manifest.version, "package-lock.json and manifest.json versions must match");
  assert.equal(lock.packages?.[""]?.version, manifest.version,
    "The package-lock.json root package version must match manifest.json");
  if (refType === "tag") {
    assert.equal(refName, manifest.version,
      "The release tag must exactly match manifest.json version (for example 0.7.0, not v0.7.0)");
  }
  return manifest.version;
}

if (require.main === module) {
  const root = resolve(__dirname, "../..");
  const read = name => JSON.parse(readFileSync(resolve(root, name), "utf8"));
  const version = validateRelease(
    read("manifest.json"), read("package.json"), read("package-lock.json"),
    process.env.GITHUB_REF_TYPE, process.env.GITHUB_REF_NAME,
  );
  console.log(`Release metadata validated: ${version}`);
}

module.exports = { validateRelease };
