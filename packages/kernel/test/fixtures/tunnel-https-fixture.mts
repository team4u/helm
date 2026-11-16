/**
 * HTTPS tunnel fixture(two phase child process script):
 * - phase=ca: generate test CA and service certificate, output JSON { caCert, key, cert } path;
 * - phase=request(env HELM_TUNNEL_TLS_KEY/CERT/CA): with NODE_EXTRA_CA_CERTS
 *   inject trust chain (process at startup takes effect) run real HTTPS tunnel request, output
 *   { ok, status, body }.
 *
 * Node only in process at startup read NODE_EXTRA_CA_CERTS, therefore two phase each start a process;
 * client certificate validate away Node by default trust chain + inject CA, never fabricate skip validate.
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { attachNodeWsGateway, attachNodeTunnelGateway, createEnvFabric } from '@helm/kernel'
import { createNodeDaemon } from '@helm/node'

const execFileAsync = promisify(execFile)
const phase = process.argv[2] ?? 'request'

async function generateCertificates(): Promise<{ caCert: string; key: string; cert: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'helm-tunnel-tls-'))
  const caKey = join(dir, 'ca-key.pem')
  const caCert = join(dir, 'ca-cert.pem')
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  const csr = join(dir, 'csr.pem')
  const ext = join(dir, 'ext.cnf')
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', caKey, '-out', caCert, '-days', '2',
    '-subj', '/CN=helm-test-ca',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ])
  await execFileAsync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=127.0.0.1'])
  await writeFile(ext, 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
  await execFileAsync('openssl', ['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '2', '-extfile', ext])
  return { caCert, key, cert }
}

async function runRequest(): Promise<void> {
  const keyPath = requireEnv('HELM_TUNNEL_TLS_KEY')
  const certPath = requireEnv('HELM_TUNNEL_TLS_CERT')
  const server = https.createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`https-echo:${req.method}:${req.url}`)
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port

  const fabric = createEnvFabric({
    authenticate: (id, token) => id === 'tls-node' && token === 'tls-node:secret',
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 60_000,
  })
  const hubServer = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  await new Promise<void>((resolve) => hubServer.listen(0, '127.0.0.1', resolve))
  const hubPort = (hubServer.address() as net.AddressInfo).port
  const gateway = attachNodeWsGateway(hubServer, { registry: fabric.registry })
  const tunnelGateway = attachNodeTunnelGateway(hubServer, { registry: fabric.registry })
  const nodeData = mkdtempSync(join(tmpdir(), 'helm-tunnel-tls-node-'))
  const daemon = await createNodeDaemon({
    hubUrl: `http://127.0.0.1:${hubPort}`,
    identity: { nodeId: 'tls-node', token: 'tls-node:secret' },
    dataDir: nodeData,
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 800,
    log: () => undefined,
  })
  try {
    if (!(await daemon.waitUntilRegistered(10_000))) throw new Error('daemon not registered')
    const response = await fabric.nodeFetch('tls-node')(`https://127.0.0.1:${port}/v1/x?k=v`)
    const body = await response.text()
    process.stdout.write(JSON.stringify({ ok: response.status === 200 && body === 'https-echo:GET:/v1/x?k=v', status: response.status, body }))
  } finally {
    await daemon.close()
    await tunnelGateway.close()
    await gateway.close()
    await new Promise<void>((resolve) => hubServer.close(() => resolve()))
    await fabric.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(nodeData, { recursive: true, force: true })
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`missing environment variable ${name}`)
  return value
}

if (phase === 'ca') {
  generateCertificates()
    .then((paths) => { process.stdout.write(JSON.stringify(paths)) })
    .catch((error: unknown) => {
      process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      process.exitCode = 1
    })
} else {
  runRequest().catch((error: unknown) => {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    process.exitCode = 1
  })
}
