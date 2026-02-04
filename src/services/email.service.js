import nodemailer from 'nodemailer';
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';

/**
 * Email service for sending notifications
 */
class EmailService {
    constructor() {
        this.transporter = null;
        this.adminEmail = ENV.ADMIN_EMAIL || 'forexfundamentaledge@gmail.com';
        this.initializeTransporter();
    }

    /**
     * Initialize email transporter
     */
    initializeTransporter() {
        try {
            // If SMTP credentials are provided, use them
            if (ENV.SMTP_USER && ENV.SMTP_PASSWORD) {
                // Remove spaces from app password (Gmail app passwords should be used without spaces)
                const cleanPassword = ENV.SMTP_PASSWORD.replace(/\s+/g, '').trim();
                
                // Debug: Log password info (masked for security)
                const passwordLength = cleanPassword.length;
                const passwordPreview = passwordLength > 0 ? `${cleanPassword.substring(0, 2)}${'*'.repeat(Math.max(0, passwordLength - 4))}${cleanPassword.substring(passwordLength - 2)}` : 'empty';
                logger.info(`Email config - User: ${ENV.SMTP_USER}, Password length: ${passwordLength}, Preview: ${passwordPreview}`);
                
                // Verify password length (Gmail app passwords are 16 characters)
                if (passwordLength !== 16) {
                    logger.warn(`Warning: App password length is ${passwordLength} characters. Gmail app passwords should be exactly 16 characters.`);
                }
                
                this.transporter = nodemailer.createTransport({
                    host: ENV.SMTP_HOST,
                    port: ENV.SMTP_PORT,
                    secure: ENV.SMTP_SECURE, // true for 465, false for other ports
                    auth: {
                        user: ENV.SMTP_USER.trim(),
                        pass: cleanPassword,
                    },
                    // Additional options for Gmail
                    tls: {
                        rejectUnauthorized: false,
                        ciphers: 'SSLv3'
                    },
                    // Gmail-specific settings
                    requireTLS: true,
                });
                
                // Test the connection
                this.transporter.verify((error, success) => {
                    if (error) {
                        logger.error(`Email transporter verification failed: ${error.message}`);
                        if (error.code === 'EAUTH' || error.responseCode === 535) {
                            logger.error(`Authentication failed. Please verify:`);
                            logger.error(`  1. SMTP_USER is correct: ${ENV.SMTP_USER}`);
                            logger.error(`  2. SMTP_PASSWORD is a valid App Password (exactly 16 characters, no spaces)`);
                            logger.error(`  3. 2-Step Verification is enabled on the Google account`);
                            logger.error(`  4. The App Password was generated for the correct account (${ENV.SMTP_USER})`);
                            logger.error(`  5. Try generating a NEW App Password at: https://myaccount.google.com/apppasswords`);
                            logger.error(`  6. Make sure to copy the password immediately after generation`);
                        }
                    } else {
                        logger.info(`✅ Email transporter verified successfully (${ENV.SMTP_HOST}:${ENV.SMTP_PORT})`);
                    }
                });
                
                logger.info(`Email transporter initialized with SMTP credentials (${ENV.SMTP_HOST}:${ENV.SMTP_PORT})`);
            } else {
                // Fallback: Use Gmail with app password or OAuth2
                // For Gmail, you need to use an App Password, not your regular password
                logger.warn('SMTP credentials not configured. Email notifications will not work.');
                logger.warn('To enable email notifications, add these to your .env file:');
                logger.warn('  SMTP_HOST=smtp.gmail.com');
                logger.warn('  SMTP_PORT=587');
                logger.warn('  SMTP_SECURE=false');
                logger.warn('  SMTP_USER=your-email@gmail.com');
                logger.warn('  SMTP_PASSWORD=your-app-password');
                logger.warn('  ADMIN_EMAIL=forexfundamentaledge@gmail.com');
                logger.warn('For Gmail, generate an App Password at: https://myaccount.google.com/apppasswords');
            }
        } catch (error) {
            logger.error(`Failed to initialize email transporter: ${error.message}`, error);
        }
    }

    /**
     * Send email notification
     * @param {string} subject - Email subject
     * @param {string} htmlBody - Email HTML body
     * @param {string} textBody - Email plain text body (optional)
     * @returns {Promise<boolean>} True if email sent successfully
     */
    async sendEmail(subject, htmlBody, textBody = null) {
        if (!this.transporter) {
            logger.warn('Email transporter not initialized. Cannot send email.');
            return false;
        }

        try {
            const mailOptions = {
                from: `"Forex Admin System" <${ENV.SMTP_USER || this.adminEmail}>`,
                to: this.adminEmail,
                subject: subject,
                html: htmlBody,
                text: textBody || this.htmlToText(htmlBody),
            };

            const info = await this.transporter.sendMail(mailOptions);
            logger.info(`Email sent successfully to ${this.adminEmail}. MessageId: ${info.messageId}`);
            return true;
        } catch (error) {
            // Provide helpful error messages for common authentication issues
            if (error.code === 'EAUTH' || error.responseCode === 535) {
                logger.error(`Failed to send email: Authentication failed. Please check your SMTP credentials.`);
                logger.error(`Make sure you're using an App Password (not your regular Gmail password).`);
                logger.error(`App passwords should be 16 characters without spaces.`);
            } else {
                logger.error(`Failed to send email: ${error.message}`, error);
            }
            return false;
        }
    }

    /**
     * Send scraper failure notification
     * @param {string} scraperName - Name of the scraper (e.g., "Risk Mode Scraper", "Retail Sentiment Scraper")
     * @param {string} errorMessage - Error message
     * @param {number} failureCount - Number of consecutive failures
     * @returns {Promise<boolean>} True if email sent successfully
     */
    async sendScraperFailureNotification(scraperName, errorMessage, failureCount) {
        const subject = `⚠️ ${scraperName} - Failed ${failureCount} Consecutive Times`;
        
        const htmlBody = `
            <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                        .header { background-color: #dc3545; color: white; padding: 15px; border-radius: 5px 5px 0 0; }
                        .content { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 5px 5px; }
                        .error-box { background-color: #fff; border-left: 4px solid #dc3545; padding: 15px; margin: 15px 0; }
                        .footer { margin-top: 20px; font-size: 12px; color: #666; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h2>⚠️ Scraper Failure Alert</h2>
                        </div>
                        <div class="content">
                            <p><strong>Scraper Name:</strong> ${scraperName}</p>
                            <p><strong>Consecutive Failures:</strong> ${failureCount}</p>
                            <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
                            
                            <div class="error-box">
                                <strong>Error Details:</strong><br>
                                <pre style="white-space: pre-wrap; word-wrap: break-word;">${errorMessage}</pre>
                            </div>
                            
                            <p><strong>Action Required:</strong> Please check the scraper configuration and network connectivity.</p>
                        </div>
                        <div class="footer">
                            <p>This is an automated notification from the Forex Admin System.</p>
                        </div>
                    </div>
                </body>
            </html>
        `;

        const textBody = `
Scraper Failure Alert

Scraper Name: ${scraperName}
Consecutive Failures: ${failureCount}
Timestamp: ${new Date().toISOString()}

Error Details:
${errorMessage}

Action Required: Please check the scraper configuration and network connectivity.

This is an automated notification from the Forex Admin System.
        `;

        return await this.sendEmail(subject, htmlBody, textBody);
    }

    /**
     * Convert HTML to plain text (simple implementation)
     * @param {string} html - HTML string
     * @returns {string} Plain text
     */
    htmlToText(html) {
        return html
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .trim();
    }
}

// Export singleton instance
export const emailService = new EmailService();
