import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailService {
  private transporter;

  constructor(private configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port: this.configService.get<number>('SMTP_PORT'),
      secure: this.configService.get<boolean>('SMTP_SECURE'),
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  async sendOtpEmail(to: string, otp: string) {
    await this.transporter.sendMail({
      from: `"Omni Suite AI" <${this.configService.get<string>('SMTP_USER')}>`,
      to, // recipient from user form
      subject: 'Email Verification OTP',
      html: `
        <h2>Email Verification</h2>
        <p>Your OTP is:</p>
        <h1>${otp}</h1>
        <p>This OTP will expire in 10 minutes.</p>
      `,
    });
  }

  async sendNewPasswordEmail(to: string, newPassword: string) {
    await this.transporter.sendMail({
      from: `"Support" <${this.configService.get('SMTP_USER')}>`,
      to,
      subject: 'Your New Password',
      html: `
        <h2>Password Reset</h2>
        <p>Your new password is:</p>
        <h3>${newPassword}</h3>
        <p>Please login and change it immediately.</p>
      `,
    });
  }
}
