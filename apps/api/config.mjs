import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'

export const configPath = process.env.MCC_CRAFTY_CONFIG
  ?? join(process.env.LOCALAPPDATA || join(homedir(), '.config'), 'MinecraftControlCenter', 'crafty.json')
export const apiPort = 4174

export function loadCraftyConfig() {
  const { url, name, serverId, certificate, token, controlToken, commandToken, listToken, backupToken, backupId } = JSON.parse(readFileSync(configPath, 'utf8'))
  const address = new URL(url)
  if (address.protocol !== 'https:' || address.hostname !== '127.0.0.1' || address.pathname !== '/' || address.search || address.hash || address.username || address.password) {
    throw new Error('Adres Crafty musi wskazywać lokalny tunel HTTPS.')
  }
  if (typeof name !== 'string' || name.length > 100 || !name.trim()
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(serverId)
    || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    throw new Error('Brakuje poprawnej nazwy, identyfikatora lub tokenu Crafty.')
  }
  if (controlToken != null && (typeof controlToken !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(controlToken) || controlToken === token)) {
    throw new Error('Sterowanie wymaga oddzielnego tokenu Crafty.')
  }
  if (commandToken != null && (typeof commandToken !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(commandToken)
    || commandToken === token || commandToken === controlToken)) throw new Error('Komendy wymagają oddzielnego tokenu Crafty.')
  if (listToken != null && (typeof listToken !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(listToken)
    || listToken === token || listToken === controlToken || commandToken != null)) {
    throw new Error('Tryb próby wymaga oddzielnego tokenu Crafty.')
  }
  if ((backupToken != null || backupId != null) && (
    typeof backupToken !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(backupToken) || [token, controlToken, commandToken, listToken].includes(backupToken)
    || typeof backupId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(backupId)
  )) throw new Error('Kopie wymagają osobnego tokenu i identyfikatora konfiguracji Crafty.')
  const fingerprint = new X509Certificate(certificate).fingerprint256
  return { address, name, serverId, certificate, fingerprint, token, controlToken: controlToken ?? null,
    commandToken: commandToken ?? null, listToken: listToken ?? null, backupToken: backupToken ?? null, backupId: backupId ?? null }
}
