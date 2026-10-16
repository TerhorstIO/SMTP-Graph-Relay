declare module 'multer' {
    import { RequestHandler } from 'express';

    interface MemoryFile {
        fieldname: string;
        originalname: string;
        mimetype: string;
        size: number;
        buffer: Buffer;
    }

    interface MulterInstance {
        fields(fields: Array<{ name: string; maxCount?: number }>): RequestHandler;
    }

    interface MulterFactory {
        (options?: {
            storage?: unknown;
            limits?: { fileSize?: number; fieldSize?: number; files?: number };
        }): MulterInstance;
        memoryStorage(): unknown;
    }

    const multer: MulterFactory;
    export = multer;
}

declare module 'selfsigned' {
    interface GenerateResult {
        private: string;
        public: string;
        cert: string;
        fingerprint: string;
    }

    interface SelfsignedApi {
        generate(
            attrs: Array<{ name: string; value: string }>,
            options?: {
                days?: number;
                keySize?: number;
                algorithm?: string;
                extensions?: unknown[];
            },
        ): GenerateResult;
    }

    const selfsigned: SelfsignedApi;
    export = selfsigned;
}
