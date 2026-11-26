/** Persistent, human-controlled origin consent; never writable from the native host. */
export async function accessPolicy(api) {
  const { access = { paused: true, origins: [], blocked: [] } } =
    await api.storage.local.get("access");
  // Existing installations store only the selected origins.
  return { ...access, allSites: access.allSites === true };
}

export function permitted(url, policy) {
  if (policy.paused) return false;
  try {
    const parsed = new URL(url);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !policy.blocked.includes(parsed.origin) &&
      (policy.allSites === true || policy.origins.includes(parsed.origin))
    );
  } catch (error) {
    if (error instanceof TypeError) return false; // Non-web Chrome targets are not eligible.
    throw error;
  }
}

export function exactOrigins(text) {
  return [...new Set(text.split(/\s+/).filter(Boolean))].map((value) => {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      value !== url.origin ||
      url.hostname.includes("*")
    )
      throw Error(
        "Use exact http(s) origins, without paths, query, credentials or trailing slash.",
      );
    return url.origin;
  });
}
