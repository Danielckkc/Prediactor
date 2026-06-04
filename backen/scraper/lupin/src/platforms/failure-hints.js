const BRITTLE_BUILTIN_PLATFORMS = new Set(["instagram", "tiktok", "x", "youtube"]);

function isLikelyUserInputError(message) {
  return /unsupported .*url|missing or invalid|invalid url|unknown .*tool|unknown .*platform/i.test(message || "");
}

export function buildPlatformFailureHint(platform) {
  if (!platform) return null;

  if (platform.sourceKind === "builtin") {
    const action = BRITTLE_BUILTIN_PLATFORMS.has(platform.name)
      ? "Run `lupin doctor` or `lupin update check` to see whether a newer Lupin release includes provider fixes."
      : "Run `lupin doctor` to see whether a newer Lupin release is available.";
    return {
      kind: "provider-update",
      platform: platform.name,
      sourceKind: "builtin",
      message: `${platform.displayName || platform.name} is built into lupin-cli and may need a Lupin update if the site changed.`,
      action,
      commands: ["lupin doctor", "lupin update check"],
    };
  }

  if (platform.sourceKind === "npm") {
    return {
      kind: "provider-update",
      platform: platform.name,
      sourceKind: "npm",
      message: `${platform.displayName || platform.name} is npm-backed and may need a provider package update if the site changed.`,
      action: `Run \`lupin platform update --check ${platform.name}\` or \`lupin platform update ${platform.name}\`.`,
      commands: [`lupin platform update --check ${platform.name}`, `lupin platform update ${platform.name}`],
    };
  }

  if (platform.sourceKind === "path") {
    return {
      kind: "provider-update",
      platform: platform.name,
      sourceKind: "path",
      message: `${platform.displayName || platform.name} is path-backed and may need local provider code or selector changes.`,
      action: `Update the local provider files, then run \`lupin platform update ${platform.name}\` to revalidate.`,
      commands: [`lupin platform update ${platform.name}`],
    };
  }

  return null;
}

export function attachPlatformFailureHint(error, platform) {
  const message = error?.message || String(error);
  if (isLikelyUserInputError(message)) return error;

  const hint = buildPlatformFailureHint(platform);
  if (hint && error && typeof error === "object") {
    error.updateHint = hint;
  }
  return error;
}

