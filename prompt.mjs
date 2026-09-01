// Which saved prompt a review runs on. The review's own pick wins, then the
// repo's, then the one named Default. A name that no longer exists is skipped
// rather than followed, so deleting a profile cannot leave a review with
// nothing to say. Null means fall back to SKILL.md.
export const pickPrompt = (reviewPrompt, repoPrompt, names) =>
  [reviewPrompt, repoPrompt, 'Default'].find((n) => n && names.includes(n)) ?? null

// Which commit of the PR a review is pinned to. The input is whatever was typed
// or clicked, the list is the PR's own commits, so a sha from somewhere else
// never reaches a spawn argument. A prefix under 7 characters is refused
// because short ones collide, and so is one that matches two commits.
export const pickCommit = (input, oids) => {
  const want = String(input ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(want)) return null
  const hits = oids.filter((oid) => oid.toLowerCase().startsWith(want))
  return hits.length === 1 ? hits[0] : null
}
