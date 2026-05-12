import cron from 'node-cron';
import { logger } from '../utils/logger.util.js';
export class CronService {
    constructor() {
        this.jobs = new Map();
    }
    startJob(name, schedule, task, options = {}) {
        if (this.jobs.has(name)) {
            this.stopJob(name);
        }
        const job = cron.schedule(schedule, async () => {
            try {
                logger.info(`Executing cron job: ${name}`);
                await task();
            }
            catch (error) {
                logger.error(`Error executing cron job ${name}: ${error.message}`, error);
            }
        }, {
            scheduled: false,
            timezone: options.timezone || 'UTC',
        });
        job.start();
        this.jobs.set(name, job);
        logger.info(`Started cron job: ${name} with schedule: ${schedule}`);
    }
    stopJob(name) {
        const job = this.jobs.get(name);
        if (job) {
            job.stop();
            this.jobs.delete(name);
            logger.info(`Stopped cron job: ${name}`);
        }
    }
    stopAll() {
        for (const [name, job] of this.jobs) {
            job.stop();
            logger.info(`Stopped cron job: ${name}`);
        }
        this.jobs.clear();
    }
    getStatus() {
        return Array.from(this.jobs.keys()).map(name => ({
            name,
            running: this.jobs.get(name).running || false,
        }));
    }
}
export const cronService = new CronService();
