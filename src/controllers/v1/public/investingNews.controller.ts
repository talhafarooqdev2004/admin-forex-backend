import axios from 'axios';
import type { NextFunction, Request, Response } from 'express';
import { XMLParser } from 'fast-xml-parser';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';

const INVESTING_RSS_URL = 'https://www.investing.com/rss/investing_news.rss';

type ParsedRssItem = {
    title?: string;
    link?: string;
    pubDate?: string;
};

type ParsedRss = {
    rss?: {
        channel?: {
            item?: ParsedRssItem | ParsedRssItem[];
        };
    };
};

const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
});

function toArray<T>(value: T | T[] | undefined): T[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

export const getInvestingNews = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const response = await axios.get<string>(INVESTING_RSS_URL, {
            responseType: 'text',
            timeout: 10000,
            headers: {
                Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
                'User-Agent': 'Mozilla/5.0 ForexDashboard/1.0',
            },
        });

        const parsed = parser.parse(response.data) as ParsedRss;
        const items = toArray(parsed.rss?.channel?.item)
            .map((item) => ({
                title: item.title?.trim() ?? '',
                link: item.link?.trim() ?? '',
                pubDate: item.pubDate?.trim() ?? '',
                source: 'Investing.com',
            }))
            .filter((item) => item.title && item.link);

        res.status(HTTP_STATUS.OK).json(successResponse('Investing.com news retrieved successfully', items));
    } catch (error) {
        next(error);
    }
};
