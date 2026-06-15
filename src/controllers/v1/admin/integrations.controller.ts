import { getTelegramChats, saveTelegramChatId, sendTelegram, sendDiscord } from '../../../services/tradeAlertNotification.service.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';

/**
 * One-time helper: lists Telegram chats the bot can currently see and auto-saves the most
 * recent one as the alert destination. Add @FOREX219_BOT to the group/channel and post a
 * message first, then call this.
 */
export const detectTelegramChat = async (req, res, next) => {
    try {
        const chats = await getTelegramChats();
        let saved: string | null = null;
        if (chats.length > 0) {
            saved = String(chats[chats.length - 1].id);
            await saveTelegramChatId(saved);
        }
        res.status(HTTP_STATUS.OK).json(
            successResponse(
                chats.length > 0
                    ? `Saved chat id ${saved}. ${chats.length} chat(s) detected.`
                    : 'No chats found. Add the bot to your group/channel and post a message, then retry.',
                { chats, savedChatId: saved },
            ),
        );
    } catch (error) {
        if (error instanceof Error && error.message === 'TELEGRAM_UNREACHABLE') {
            return res.status(HTTP_STATUS.OK).json(
                successResponse(
                    'Could not reach the Telegram API from this server (network/firewall). Run detection from a network that can reach api.telegram.org.',
                    { chats: [], savedChatId: null, reachable: false },
                ),
            );
        }
        next(error);
    }
};

/** Sends a test message to the enabled channels to verify the integration. */
export const sendTestAlert = async (req, res, next) => {
    try {
        const text = '🔔 Test alert from Forex Fundamental Edge — integration is working.';
        const [telegram, discord] = await Promise.all([sendTelegram(text), sendDiscord(text)]);
        if (!telegram && !discord) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'No channel delivered. Check token/webhook/chat id.');
        }
        res.status(HTTP_STATUS.OK).json(successResponse('Test alert dispatched', { telegram, discord }));
    } catch (error) {
        next(error);
    }
};
