const LONG_TASK_KEYWORDS: RegExp[] = [
  /\bredig\w*/i,
  /\bprepar\w*/i,
  /\belabor\w*/i,
  /\bgener\w*/i,
  /\bpreventiv\w*/i,
  /\bcomput\w*/i,
  /\bcme\b/i,
  /\bquadro\s+economic\w*/i,
  /\bsal\b/i,
  /\bpos\b/i,
  /\bperizi\w*/i,
  /\brelazion\w*/i,
  /\bpratic\w*/i,
  /\bscia\b/i,
  /\bcila\b/i,
  /\brelazione\s+di\s+calcol\w*/i,
]

const FILE_SIZE_THRESHOLD_BYTES = 100_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyTask(userText: string, fileBlocks: any[]): boolean {
  if (LONG_TASK_KEYWORDS.some((re) => re.test(userText))) return true
  if (fileBlocks.length > 0 && JSON.stringify(fileBlocks).length > FILE_SIZE_THRESHOLD_BYTES) {
    return true
  }
  return false
}
