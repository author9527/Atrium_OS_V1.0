/**
 * local/backup.ts — 手机端全量备份与恢复服务
 *
 * 全量备份 = 复制 SQLite 库文件 + 导出 AsyncStorage 键值（剔除 API Key），
 * 用用户「备份加密密码」经 scrypt 派生密钥后 AES-GCM 加密，打包为单个 .abk JSON 文件。
 *
 * 密码说明：本软件无账号/登录密码体系。此处的「密码」是备份加密密码，
 * 仅作用于单个备份文件，导出时现场设定、导入时现场输入，软件不存储、不落盘，
 * 遗忘即无法解开该备份。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { scrypt } from '@noble/hashes/scrypt.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';
import { base64 } from '@scure/base';
import { getDiaryStorage, getDatabaseFilePath, restoreDatabaseFromFile } from '../core/db/diaryDb';

const BACKUP_TYPE = 'atrium-full-backup';
const BACKUP_VERSION = 2;
/** scrypt 成本参数（N 为 2 的幂，16384 在移动端耗时约数百毫秒，属可接受范围） */
const KDF = { N: 16384, r: 8, p: 1, dkLen: 32 };
/** 备份中剔除的敏感设置键（子串匹配），避免 API Key 明文外泄 */
const SENSITIVE_KEY_PARTS = ['openrouterApiKey', 'openrouter_api_key'];

export interface BackupResult {
  success: boolean;
  message: string;
  fileUri?: string;
  needsRestart?: boolean;
}

/** 判断一段文本是否为全量备份包（含 manifest 标识 + ciphertext 密文） */
export function isFullBackupPackage(text: string): boolean {
  try {
    const obj = JSON.parse(text);
    return !!(obj && obj.manifest && obj.manifest.type === BACKUP_TYPE && obj.ciphertext);
  } catch {
    return false;
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PARTS.some((part) => key.includes(part));
}

/**
 * 导出全部数据为单个加密 .abk 文件，并弹出系统分享面板。
 * @param password 备份加密密码（现场设定，仅作用于本次备份，不落盘）
 */
export async function exportFullBackup(password: string): Promise<BackupResult> {
  try {
    if (!password || !password.trim()) {
      return { success: false, message: '请先设置备份密码' };
    }

    // 1. 把 WAL 合并回主库，保证复制的库文件完整
    getDiaryStorage().checkpoint();

    // 2. 读取数据库文件为 base64
    const dbFile = new File(getDatabaseFilePath());
    if (!dbFile.exists) {
      return { success: false, message: '数据库文件不存在，暂无可导出的数据' };
    }
    const databaseB64 = await dbFile.base64();

    // 3. 导出 AsyncStorage 键值，剔除敏感项（API Key）
    const allKeys = await AsyncStorage.getAllKeys();
    const pairs = await AsyncStorage.multiGet(allKeys);
    const settings: Record<string, string> = {};
    for (const [k, v] of pairs) {
      if (v == null || isSensitiveKey(k)) continue;
      settings[k] = v;
    }

    // 4. 组装明文载荷并经 scrypt 派生密钥 + AES-GCM 加密
    const payload = JSON.stringify({ database: databaseB64, settings });
    const salt = randomBytes(16);
    const key = scrypt(utf8ToBytes(password), salt, KDF);
    const iv = randomBytes(12);
    const cipher = gcm(key, iv);
    const ciphertext = cipher.encrypt(utf8ToBytes(payload)); // 密文末尾已含 16 字节 GCM tag

    // 5. 组装加密包
    const pkg = {
      manifest: {
        type: BACKUP_TYPE,
        version: BACKUP_VERSION,
        appVersion: '1.0.0',
        exportedAt: new Date().toISOString(),
        encrypted: true,
        kdf: { name: 'scrypt', salt: base64.encode(salt), N: KDF.N, r: KDF.r, p: KDF.p },
      },
      iv: base64.encode(iv),
      ciphertext: base64.encode(ciphertext),
    };
    const json = JSON.stringify(pkg);

    // 6. 写入缓存文件（相对沙盒缓存目录，不写死绝对路径）并分享
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `atrium_backup_${dateStr}.abk`;
    const file = new File(Paths.cache, fileName);
    if (file.exists) file.delete();
    file.create({ overwrite: true });
    file.write(json);

    if (!(await Sharing.isAvailableAsync())) {
      return { success: false, message: '当前设备不支持分享，备份文件已生成但无法分享' };
    }
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      dialogTitle: '导出全部数据',
    });
    return { success: true, message: '全量备份已导出', fileUri: file.uri };
  } catch (e: any) {
    return { success: false, message: e?.message || '导出全量备份失败' };
  }
}

/**
 * 从 .abk 全量备份恢复数据（恢复 AsyncStorage + 替换数据库文件）。
 * @param uri 备份文件 URI
 * @param password 备份加密密码（当时设定，现场输入）
 */
export async function importFullBackup(uri: string, password: string): Promise<BackupResult> {
  try {
    const file = new File(uri);
    if (!file.exists) {
      return { success: false, message: '备份文件不存在' };
    }
    const text = await file.text();

    let pkg: any;
    try {
      pkg = JSON.parse(text);
    } catch {
      return { success: false, message: '备份文件已损坏，无法解析' };
    }
    if (!pkg || pkg.manifest?.type !== BACKUP_TYPE) {
      return { success: false, message: '不是有效的 Atrium 全量备份文件' };
    }
    if (pkg.manifest.version !== BACKUP_VERSION) {
      return { success: false, message: `不支持的备份版本（${pkg.manifest.version}）` };
    }

    // 派生密钥（参数取自 manifest，兼容不同导出批次）
    const kdf = pkg.manifest.kdf || {};
    const salt = base64.decode(typeof kdf.salt === 'string' ? kdf.salt : '');
    const key = scrypt(utf8ToBytes(password), salt, {
      N: Number(kdf.N) || KDF.N,
      r: Number(kdf.r) || KDF.r,
      p: Number(kdf.p) || KDF.p,
      dkLen: KDF.dkLen,
    });

    // 解密（GCM 会校验 tag，密码错误或数据被篡改都会在此抛错）
    const iv = base64.decode(pkg.iv || '');
    const ciphertext = base64.decode(pkg.ciphertext || '');
    const cipher = gcm(key, iv);
    let plaintext: Uint8Array;
    try {
      plaintext = cipher.decrypt(ciphertext);
    } catch {
      return { success: false, message: '密码错误，无法解密该备份' };
    }

    // 解析载荷
    let payload: any;
    try {
      payload = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      return { success: false, message: '备份解密成功，但内容格式异常' };
    }

    // 恢复 AsyncStorage（同样剔除敏感项）
    const settings = (payload && payload.settings) || {};
    const restorePairs = Object.keys(settings)
      .filter((k) => !isSensitiveKey(k))
      .map((k) => [k, String(settings[k])] as [string, string]);
    if (restorePairs.length) {
      await AsyncStorage.multiSet(restorePairs);
    }

    // 恢复数据库：先写临时文件，再原子替换
    const databaseB64 = payload && payload.database;
    if (databaseB64) {
      const tmp = new File(Paths.cache, `_atrium_restore_${Date.now()}.db`);
      if (tmp.exists) tmp.delete();
      tmp.create();
      tmp.write(base64.decode(databaseB64));
      await restoreDatabaseFromFile(tmp.uri);
      if (tmp.exists) tmp.delete();
    }

    return { success: true, message: '全量数据已恢复，请重启应用以生效', needsRestart: true };
  } catch (e: any) {
    return { success: false, message: e?.message || '恢复全量备份失败' };
  }
}