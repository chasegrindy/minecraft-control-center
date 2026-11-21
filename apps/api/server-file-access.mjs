export function parseServerFileGroup(value) {
  if (value === undefined) return null
  return /^[1-9]\d{0,9}$/.test(value) ? Number(value) : NaN
}

export function canShareServerFile(info, groupId, groupMode) {
  if (groupId === null) return !process.getuid || info.uid === process.getuid()
  return process.platform === 'linux' && Number.isInteger(groupId) && groupId > 0 && groupId < 0xffffffff
    && info.gid === groupId && (info.mode & groupMode) === groupMode && process.getgroups().includes(groupId)
}

export async function shareServerFile(handle, groupId, mode) {
  if (groupId === null) return
  await handle.chown(process.getuid(), groupId)
  await handle.chmod(mode)
}
