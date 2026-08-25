import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

interface EncryptedSecret {
  algorithm: 'aes-256-gcm';
  iv: string;
  authTag: string;
  ciphertext: string;
}

@Injectable()
export class LlmSecretService {
  async store(value: string): Promise<string> {
    if (!value.trim()) {
      throw new BadRequestException('The API key must not be empty');
    }

    const encryptionKey = this.encryptionKey();
    const directory = this.storageDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const envelope: EncryptedSecret = {
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };

    const path = join(directory, `${randomUUID()}.secret.json`);
    await writeFile(path, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    return `encrypted-file:${path}`;
  }

  async resolve(reference: string): Promise<string> {
    if (reference.startsWith('env:')) {
      const variableName = reference.slice(4);

      if (!/^[A-Z][A-Z0-9_]*$/.test(variableName)) {
        throw new BadRequestException('Invalid environment secret reference');
      }

      const value = process.env[variableName];

      if (!value) {
        throw new InternalServerErrorException(`Secret environment variable ${variableName} is not configured`);
      }

      return value;
    }

    if (reference.startsWith('file:')) {
      const path = reference.slice(5);

      if (!isAbsolute(path)) {
        throw new BadRequestException('Mounted secret file references must use absolute paths');
      }

      const value = (await readFile(path, 'utf8')).trim();

      if (!value) {
        throw new InternalServerErrorException('The referenced secret file is empty');
      }

      return value;
    }

    if (reference.startsWith('encrypted-file:')) {
      const path = resolve(reference.slice('encrypted-file:'.length));
      const directory = this.storageDirectory();

      if (path !== directory && !path.startsWith(`${directory}${sep}`)) {
        throw new BadRequestException('Encrypted secret reference is outside the configured secret directory');
      }

      const envelope = JSON.parse(await readFile(path, 'utf8')) as EncryptedSecret;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey(),
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    }

    throw new BadRequestException(
      'Unsupported secret reference. Use env:NAME, file:/absolute/path, or an internally managed encrypted file.',
    );
  }

  hint(value: string): string {
    return value.length <= 8 ? '****' : `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  private storageDirectory(): string {
    return resolve(process.cwd(), process.env.SECRET_STORAGE_DIR ?? '.secrets');
  }

  private encryptionKey(): Buffer {
    const configured = process.env.SECRET_ENCRYPTION_KEY;

    if (!configured) {
      throw new BadRequestException(
        'SECRET_ENCRYPTION_KEY is required when an API key is submitted directly; use apiKeySecretRef for an existing mounted or environment secret',
      );
    }

    const key = Buffer.from(configured, 'base64');

    if (key.length !== 32) {
      throw new InternalServerErrorException('SECRET_ENCRYPTION_KEY must contain 32 base64-encoded bytes');
    }

    return key;
  }
}
