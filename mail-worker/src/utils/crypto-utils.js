const encoder = new TextEncoder();

// Passwords are hashed with PBKDF2-SHA256. The iteration count is stored with each
// hash ("pbkdf2$<iterations>$<base64>") so it can be raised later; 25k keeps a login
// within the Workers Free plan's 10 ms CPU budget (workerd caps PBKDF2 at 100k).
const PBKDF2_PREFIX = 'pbkdf2$';
const PBKDF2_ITERATIONS = 25000;
const PBKDF2_MAX_ITERATIONS = 100000;

function toBase64(buffer) {
	return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function constantTimeEqual(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

const saltHashUtils = {

	generateSalt(length = 16) {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return btoa(String.fromCharCode(...array));
	},


	async hashPassword(password) {
		const salt = this.generateSalt();
		const hash = await this.pbkdf2Hash(password, salt, PBKDF2_ITERATIONS);
		return { salt, hash };
	},

	async pbkdf2Hash(password, salt, iterations) {
		const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
		const bits = await crypto.subtle.deriveBits(
			{ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations },
			key,
			256
		);
		return `${PBKDF2_PREFIX}${iterations}$${toBase64(bits)}`;
	},

	// Legacy scheme (single salted SHA-256); only used to verify hashes created before PBKDF2.
	async genHashPassword(password, salt) {
		const data = encoder.encode(salt + password);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		return toBase64(hashBuffer);
	},

	async verifyPassword(inputPassword, salt, storedHash) {
		if (typeof inputPassword !== 'string' || typeof storedHash !== 'string') {
			return false;
		}
		if (storedHash.startsWith(PBKDF2_PREFIX)) {
			const iterations = Number(storedHash.slice(PBKDF2_PREFIX.length).split('$')[0]);
			if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) {
				return false;
			}
			return constantTimeEqual(await this.pbkdf2Hash(inputPassword, salt, iterations), storedHash);
		}
		return constantTimeEqual(await this.genHashPassword(inputPassword, salt), storedHash);
	},

	needsRehash(storedHash) {
		return typeof storedHash !== 'string' || !storedHash.startsWith(`${PBKDF2_PREFIX}${PBKDF2_ITERATIONS}$`);
	},

	genRandomPwd(length = 8) {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < length; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}
};

export default saltHashUtils;
