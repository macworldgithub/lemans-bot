import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { User, UserDocument } from './schemas/user.schema';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
import { MailService } from '../common/mail/mail.service';
import { generateToken } from './utils/token.util';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mailService: MailService,
  ) {}

  private async signToken(userId: string, email: string) {
    const payload = { sub: userId, email };
    return this.jwtService.signAsync(payload, {
      secret: this.configService.get('JWT_SECRET'),
      expiresIn: '7d',
    });
  }

  async register(dto: RegisterDto) {
    const existing = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (existing) throw new BadRequestException('Email already registered');

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const newUser = new this.userModel({
      ...dto,
      password: hashedPassword,
      emailVerified: false,
      emailVerificationToken: otp,
    });

    await newUser.save();
    await this.mailService.sendOtpEmail(dto.email, otp);

    return {
      message: 'User registered successfully. Please verify your email using the OTP sent.',
      userId: newUser._id,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    if (!user.emailVerified) {
      throw new UnauthorizedException('Email not verified');
    }

    const token = await this.signToken(user._id.toString(), user.email);

    return {
      accessToken: token,
      user: {
        id: user._id,
        email: user.email,
        customerName: user.customerName,
        companyName: user.companyName,
      },
    };
  }

  async forgotPasswordEmail(email: string) {
    const user = await this.userModel.findOne({ email: email.toLowerCase() });
    if (!user) {
      // For security, don't reveal if user exists
      return { message: 'If the email exists, a new password will be sent.' };
    }

    const newPassword = generateToken().slice(0, 10);
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    user.password = hashedPassword;
    await user.save();

    await this.mailService.sendNewPasswordEmail(user.email, newPassword);

    return { message: 'If the email exists, a new password has been sent.' };
  }

  async verifyOtp(email: string, otp: string) {
    const user = await this.userModel.findOne({
      email: email.toLowerCase(),
      emailVerificationToken: otp,
    });

    if (!user) throw new BadRequestException('Invalid OTP or email');

    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    await user.save();

    return { message: 'Email verified successfully' };
  }

  async changePassword(userId: string, currentPass: string, newPass: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    const valid = await bcrypt.compare(currentPass, user.password);
    if (!valid) throw new UnauthorizedException('Current password incorrect');

    user.password = await bcrypt.hash(newPass, 10);
    await user.save();

    return { message: 'Password changed successfully' };
  }
}
