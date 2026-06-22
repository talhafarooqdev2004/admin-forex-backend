import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from '../config/env.js';
import type { DiscordEmbed } from './discordTradeAlertEmbeds.js';

/** Live dashboard URL — same logo path as the sidebar (`/images/brand-logo.png`). */
export const LIVE_SITE_URL = 'https://fxfundamentaltrend.com';

/** Same path as the dashboard sidebar (`SideBar.tsx`). */
export const SIDEBAR_BRAND_LOGO_PATH = '/images/brand-logo.png';

export const DISCORD_LOGO_FILENAME = 'brand-logo.png';
export const DISCORD_LOGO_ATTACHMENT_URL = `attachment://${DISCORD_LOGO_FILENAME}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function logoCandidates(): string[] {
    const cwd = process.cwd();
    const fromEnv = ENV.DISCORD_BRAND_LOGO_PATH?.trim();
    return [
        ...(fromEnv ? [fromEnv] : []),
        path.resolve(cwd, '../forex-dashboard/public/images/brand-logo.png'),
        path.resolve(cwd, 'public/images/brand-logo.png'),
        path.resolve(__dirname, '../../assets/images/brand-logo.png'),
    ];
}

/** Absolute path to the sidebar brand logo on disk, if available. */
export function resolveDiscordLogoFilePath(): string | null {
    for (const candidate of logoCandidates()) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

export function shouldAttachDiscordLogo(): boolean {
    if (ENV.DISCORD_BRAND_LOGO_URL) return false;
    return resolveDiscordLogoFilePath() !== null;
}

export function resolveDiscordLogoUrl(): string {
    if (ENV.DISCORD_BRAND_LOGO_URL) return ENV.DISCORD_BRAND_LOGO_URL;
    return `${LIVE_SITE_URL}${SIDEBAR_BRAND_LOGO_PATH}`;
}

export function withDiscordLogoAttachment(embed: DiscordEmbed): DiscordEmbed {
    const logoUrl = DISCORD_LOGO_ATTACHMENT_URL;
    return {
        ...embed,
        author: embed.author ? { ...embed.author, icon_url: logoUrl } : undefined,
        thumbnail: embed.thumbnail ? { ...embed.thumbnail, url: logoUrl } : { url: logoUrl },
        footer: embed.footer ? { ...embed.footer, icon_url: logoUrl } : undefined,
    };
}
