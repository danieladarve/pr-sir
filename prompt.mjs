// Which saved prompt a review runs on. The review's own pick wins, then the
// repo's, then the one named Default. A name that no longer exists is skipped
// rather than followed, so deleting a profile cannot leave a review with
// nothing to say. Null means fall back to SKILL.md.
export const pickPrompt = (reviewPrompt, repoPrompt, names) =>
  [reviewPrompt, repoPrompt, 'Default'].find((n) => n && names.includes(n)) ?? null
