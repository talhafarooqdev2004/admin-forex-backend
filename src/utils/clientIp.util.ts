import type { Request } from 'express';

function stripIpv4MappedPrefix(ip: string): string {
    const v = ip.trim();
    if (v.startsWith('::ffff:')) return v.slice(7);
    return v;
}

/** True for loopback and private/special-use ranges we should not geolocate. */
export function isNonPublicIp(ip: string): boolean {
    const v = stripIpv4MappedPrefix(ip);
    if (v === '127.0.0.1' || v === '::1' || v === '0.0.0.0') return true;
    if (v.startsWith('10.')) return true;
    if (v.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(v)) return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true;
    if (v === 'unknown') return true;
    return false;
}

export function extractClientIp(req: Request): string | null {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.length > 0) {
        const first = xf.split(',')[0]?.trim();
        if (first) return stripIpv4MappedPrefix(first);
    }
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return stripIpv4MappedPrefix(real.trim());
    const raw = req.socket?.remoteAddress;
    return raw ? stripIpv4MappedPrefix(raw) : null;
}
