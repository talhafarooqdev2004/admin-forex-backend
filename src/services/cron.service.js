import cron from 'node-cron';
import { logger } from '../utils/logger.util.js';

/**
 * Service for managing cron jobs
 */
export class CronService {
    constructor() {
        this.jobs = new Map();
    }

    /**
     * Start a cron job
     * @param {string} name - Unique name for the job
     * @param {string} schedule - Cron schedule expression (5-field: '0 * * * *' for every minute, 6-field: '0/15 * * * * *' for every 15 seconds)
     * @param {Function} task - Function to execute
     * @param {Object} options - Additional options
     */
    startJob(name, schedule, task, options = {}) {
        // Stop existing job if it exists
        if (this.jobs.has(name)) {
            this.stopJob(name);
        }

        const job = cron.schedule(schedule, async () => {
            try {
                logger.info(`Executing cron job: ${name}`);
                await task();
            } catch (error) {
                logger.error(`Error executing cron job ${name}: ${error.message}`, error);
            }
        }, {
            scheduled: false, // Don't start immediately
            timezone: options.timezone || 'UTC',
        });

        // Start the job
        job.start();
        this.jobs.set(name, job);

        logger.info(`Started cron job: ${name} with schedule: ${schedule}`);
    }

    /**
     * Stop a cron job
     * @param {string} name - Name of the job to stop
     */
    stopJob(name) {
        const job = this.jobs.get(name);
        if (job) {
            job.stop();
            this.jobs.delete(name);
            logger.info(`Stopped cron job: ${name}`);
        }
    }

    /**
     * Stop all cron jobs
     */
    stopAll() {
        for (const [name, job] of this.jobs) {
            job.stop();
            logger.info(`Stopped cron job: ${name}`);
        }
        this.jobs.clear();
    }

    /**
     * Get status of all jobs
     * @returns {Array} Array of job statuses
     */
    getStatus() {
        return Array.from(this.jobs.keys()).map(name => ({
            name,
            running: this.jobs.get(name).running || false,
        }));
    }
}

// Export singleton instance
export const cronService = new CronService();
