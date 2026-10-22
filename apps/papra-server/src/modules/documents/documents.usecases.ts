import type { PartialBy } from '@corentinth/chisels';
import type { Readable } from 'node:stream';
import type { Database } from '../app/database/database.types';
import type { EventServices } from '../app/events/events.services';
import type { Config } from '../config/config.types';
import type { CustomPropertiesRepository } from '../custom-properties/custom-properties.repository';
import type { CustomPropertiesOptionsRepository } from '../custom-properties/options/custom-properties-options.repository';
import type { OrganizationsRepository } from '../organizations/organizations.repository';
import type { PlanEntitlementsRepository } from '../plan-entitlements/plan-entitlements.repository';
import type { PlanEntitlementDefinitionRegistry } from '../plan-entitlements/plan-entitlements.registry';
import type { PlansRepository } from '../plans/plans.repository';
import type { Logger } from '../shared/logger/logger';
import type { SubscriptionsRepository } from '../subscriptions/subscriptions.repository';
import type { TaggingRulesRepository } from '../tagging-rules/tagging-rules.repository';
import type { TagsRepository } from '../tags/tags.repository';
import type { TaskServices } from '../tasks/tasks.services';
import type { DocumentsRepository } from './documents.repository';
import type { Document } from './documents.types';
import type { StorageService } from '../storage/storage.services';
import type { EncryptionContext } from '../storage/drivers/drivers.models';
import type { CreateDocumentStorageKey } from './document-storage.usecases';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safely } from '@corentinth/chisels';
import pLimit from 'p-limit';
import { buildCustomPropertiesArray } from '../custom-properties/custom-properties.models';
import { createOrganizationDocumentStorageLimitReachedError } from '../organizations/organizations.errors';
import { createOrganizationsRepository } from '../organizations/organizations.repository';
import { getOrganizationStorageLimits } from '../organizations/organizations.usecases';
import { createPlanEntitlementsRepository } from '../plan-entitlements/plan-entitlements.repository';
import { createPlanEntitlementDefinitionRegistry } from '../plan-entitlements/plan-entitlements.registry';
import { createPlansRepository } from '../plans/plans.repository';
import { createError } from '../shared/errors/errors';
import { createLogger } from '../shared/logger/logger';
import { createByteCounter } from '../shared/streams/byte-counter';
import { createSha256HashTransformer } from '../shared/streams/stream-hash';
import { collectStreamToFile } from '../shared/streams/stream.convertion';
import { isNil } from '../shared/utils';
import { createSubscriptionsRepository } from '../subscriptions/subscriptions.repository';
import { createTaggingRulesRepository } from '../tagging-rules/tagging-rules.repository';
import { applyTaggingRules } from '../tagging-rules/tagging-rules.usecases';
import { createTagsRepository } from '../tags/tags.repository';
import {
  createDocumentAlreadyExistsError,
  createDocumentNotDeletedError,
  createDocumentNotFoundError,
  createDocumentSizeTooLargeError,
} from './documents.errors';
import {
  formatDocumentForApi,
  generateDocumentId as generateDocumentIdImpl,
} from './documents.models';
import { createDocumentsRepository } from './documents.repository';
import { buildCreateDocumentStorageKey } from './document-storage.usecases';
import { buildResolveStoragePatternContext } from './storage-patterns/storage-pattern.usecases';
import type { ExtractDocumentTextUsecase } from './content-extraction/content-extraction.usecases';
import type { TagInput } from './content-extraction/content-extraction-strategies/content-extraction-strategies.types';
import { createTagsAndApplyToDocuments } from '../tags/tags.usecases';
import type { CustomPropertyType } from '../custom-properties/custom-properties.constants';
import { setDocumentCustomPropertyValue } from '../custom-properties/custom-properties.usecases';
import { buildExtractionTagActions, parseValueForPropertyType } from './documents.metadata.models';
import { documentNameMaxLength } from './documents.constants';

type DocumentStorageContext = {
  storageKey: string;
} & EncryptionContext;

export async function createDocument({
  fileStream,
  fileName,
  mimeType,
  userId,
  organizationId,
  ocrLanguages = [],
  isContentExtractionEnabled = true,
  createDocumentStorageKey,
  documentsRepository,
  documentsStorageService,
  generateDocumentId = generateDocumentIdImpl,
  plansRepository,
  subscriptionsRepository,
  planEntitlementsRepository,
  planEntitlementDefinitionRegistry,
  taggingRulesRepository,
  tagsRepository,
  eventServices,
  taskServices,
  logger = createLogger({ namespace: 'documents:usecases' }),
}: {
  fileStream: Readable;
  fileName: string;
  mimeType: string;
  userId?: string;
  organizationId: string;
  ocrLanguages?: string[];
  isContentExtractionEnabled?: boolean;
  createDocumentStorageKey: CreateDocumentStorageKey;
  documentsRepository: DocumentsRepository;
  documentsStorageService: StorageService;
  generateDocumentId?: () => string;
  plansRepository: PlansRepository;
  subscriptionsRepository: SubscriptionsRepository;
  planEntitlementsRepository: PlanEntitlementsRepository;
  planEntitlementDefinitionRegistry: PlanEntitlementDefinitionRegistry;
  taggingRulesRepository: TaggingRulesRepository;
  tagsRepository: TagsRepository;
  eventServices: EventServices;
  taskServices: TaskServices;
  logger?: Logger;
}) {
  const { availableDocumentStorageBytes, maxFileSize } = await getOrganizationStorageLimits({
    organizationId,
    plansRepository,
    subscriptionsRepository,
    planEntitlementsRepository,
    planEntitlementDefinitionRegistry,
    documentsRepository,
  });

  const documentId = generateDocumentId();
  const createdAt = new Date();
  const { storageKey } = await createDocumentStorageKey({
    documentId,
    documentName: fileName,
    documentDate: null,
    documentCreatedAt: createdAt,
    organizationId,
  });

  const { tap: hashStream, getHash } = createSha256HashTransformer();

  // Stream that will count the bytes of the file and throw an error if the file size exceeds the organization storage limit
  const { tap: byteCountStream, getByteCount } = createByteCounter({
    onByteCountChange: async ({ byteCount, destroy }) => {
      if (byteCount > availableDocumentStorageBytes) {
        destroy({ error: createOrganizationDocumentStorageLimitReachedError() });
      }

      if (byteCount > maxFileSize) {
        destroy({ error: createDocumentSizeTooLargeError() });
      }
    },
  });

  // Create a PassThrough stream that will be used for saving the file
  // This allows us to use pipeline for better error handling
  const outputStream = new PassThrough();

  const streamProcessingPromise = pipeline(fileStream, hashStream, byteCountStream, outputStream);

  // We optimistically save the file to leverage streaming, if the file already exists, we will delete it
  const [encryptionMetadata] = await Promise.all([
    documentsStorageService.saveFile({
      fileStream: outputStream,
      storageKey,
      mimeType,
      fileName,
    }),
    streamProcessingPromise,
  ]);

  const hash = getHash();
  const size = getByteCount();

  // Early check to avoid saving the file and then realizing it already exists with the db constraint
  const { document: existingDocument } =
    await documentsRepository.getOrganizationDocumentBySha256Hash({
      sha256Hash: hash,
      organizationId,
    });

  const { document } = existingDocument
    ? await handleExistingDocument({
        existingDocument,
        fileName,
        organizationId,
        documentsRepository,
        newDocumentStorageKey: storageKey,
        tagsRepository,
        taggingRulesRepository,
        eventServices,
        documentsStorageService,
        logger,
      })
    : await createNewDocument({
        createdAt,
        newFileStorageContext: { storageKey, ...encryptionMetadata },
        fileName,
        size,
        mimeType,
        hash,
        userId,
        organizationId,
        documentsRepository,
        documentsStorageService,
        plansRepository,
        subscriptionsRepository,
        planEntitlementsRepository,
        planEntitlementDefinitionRegistry,
        documentId,
        taskServices,
        ocrLanguages,
        isContentExtractionEnabled,
        logger,
      });

  eventServices.emitEvent({
    eventName: 'document.created',
    payload: { document },
  });

  return { document };
}

export type CreateDocumentUsecase = Awaited<ReturnType<typeof createDocumentCreationUsecase>>;
export type DocumentUsecaseDependencies = Omit<
  Parameters<typeof createDocument>[0],
  'fileStream' | 'fileName' | 'mimeType' | 'userId' | 'organizationId'
>;

export function createDocumentCreationUsecase({
  db,
  config,
  taskServices,
  documentsStorageService,
  eventServices,
  ...initialDeps
}: {
  db: Database;
  taskServices: TaskServices;
  documentsStorageService: StorageService;
  eventServices: EventServices;
  config: Config;
} & Partial<DocumentUsecaseDependencies>) {
  const deps = {
    documentsRepository: initialDeps.documentsRepository ?? createDocumentsRepository({ db }),
    plansRepository: initialDeps.plansRepository ?? createPlansRepository({ config }),
    subscriptionsRepository:
      initialDeps.subscriptionsRepository ?? createSubscriptionsRepository({ db }),
    planEntitlementsRepository:
      initialDeps.planEntitlementsRepository ?? createPlanEntitlementsRepository({ db }),
    planEntitlementDefinitionRegistry:
      initialDeps.planEntitlementDefinitionRegistry ??
      createPlanEntitlementDefinitionRegistry({ config }),
    taggingRulesRepository:
      initialDeps.taggingRulesRepository ?? createTaggingRulesRepository({ db }),
    tagsRepository: initialDeps.tagsRepository ?? createTagsRepository({ db }),

    createDocumentStorageKey:
      initialDeps.createDocumentStorageKey ??
      buildCreateDocumentStorageKey({
        storagePatternConfig: config.documentsStorage.pattern,
        documentsStorageService,
        resolveStoragePatternContext: buildResolveStoragePatternContext({
          organizationsRepository: createOrganizationsRepository({ db }),
        }),
      }),
    ocrLanguages: initialDeps.ocrLanguages ?? config.documents.ocrLanguages,
    isContentExtractionEnabled:
      initialDeps.isContentExtractionEnabled ?? config.documents.isContentExtractionEnabled,
    generateDocumentId: initialDeps.generateDocumentId,
    logger: initialDeps.logger,
  };

  return async (args: {
    fileStream: Readable;
    fileName: string;
    mimeType: string;
    userId?: string;
    organizationId: string;
  }) => createDocument({ taskServices, documentsStorageService, eventServices, ...args, ...deps });
}

async function handleExistingDocument({
  existingDocument,
  fileName,
  userId,
  organizationId,
  documentsRepository,
  tagsRepository,
  taggingRulesRepository,
  eventServices,
  documentsStorageService,
  newDocumentStorageKey,
  logger,
}: {
  existingDocument: Document;
  fileName: string;
  userId?: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
  tagsRepository: TagsRepository;
  taggingRulesRepository: TaggingRulesRepository;
  eventServices: EventServices;
  documentsStorageService: StorageService;
  newDocumentStorageKey: string;
  logger: Logger;
}) {
  // Delete the newly uploaded file since we'll be using the existing document's file
  await documentsStorageService.deleteFile({ storageKey: newDocumentStorageKey });

  if (!existingDocument.isDeleted) {
    throw createDocumentAlreadyExistsError();
  }

  logger.info(
    { documentId: existingDocument.id },
    'Document already exists, restoring for deduplication',
  );

  const [, { document: restoredDocument }] = await Promise.all([
    tagsRepository.removeAllTagsFromDocument({ documentId: existingDocument.id }),
    documentsRepository.restoreDocument({
      documentId: existingDocument.id,
      organizationId,
      name: fileName,
      userId,
    }),
  ]);

  await applyTaggingRules({
    document: restoredDocument,
    taggingRulesRepository,
    tagsRepository,
    eventServices,
  });

  return { document: restoredDocument };
}

async function createNewDocument({
  createdAt,
  fileName,
  size,
  mimeType,
  hash,
  userId,
  organizationId,
  plansRepository,
  subscriptionsRepository,
  planEntitlementsRepository,
  planEntitlementDefinitionRegistry,
  documentsRepository,
  documentsStorageService,
  newFileStorageContext,
  documentId,
  taskServices,
  ocrLanguages = [],
  isContentExtractionEnabled = true,
  logger,
}: {
  createdAt: Date;
  fileName: string;
  size: number;
  mimeType: string;
  hash: string;
  userId?: string;
  organizationId: string;
  documentId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: StorageService;
  plansRepository: PlansRepository;
  subscriptionsRepository: SubscriptionsRepository;
  planEntitlementsRepository: PlanEntitlementsRepository;
  planEntitlementDefinitionRegistry: PlanEntitlementDefinitionRegistry;
  newFileStorageContext: DocumentStorageContext;
  taskServices: TaskServices;
  ocrLanguages?: string[];
  isContentExtractionEnabled?: boolean;
  logger: Logger;
}) {
  // TODO: wrap in a transaction

  // Recheck for quota after saving the file to the storage
  const { availableDocumentStorageBytes } = await getOrganizationStorageLimits({
    organizationId,
    plansRepository,
    subscriptionsRepository,
    planEntitlementsRepository,
    planEntitlementDefinitionRegistry,
    documentsRepository,
  });

  if (size > availableDocumentStorageBytes) {
    logger.error(
      { size, availableDocumentStorageBytes },
      'Document size exceeds organization storage limit after being saved',
    );
    await documentsStorageService.deleteFile({ storageKey: newFileStorageContext.storageKey });

    throw createOrganizationDocumentStorageLimitReachedError();
  }

  const [result, error] = await safely(
    documentsRepository.saveOrganizationDocument({
      id: documentId,
      createdAt,
      name: fileName,
      organizationId,
      originalName: fileName,
      createdBy: userId,
      originalSize: size,
      originalStorageKey: newFileStorageContext.storageKey,
      fileEncryptionAlgorithm: newFileStorageContext.fileEncryptionAlgorithm,
      fileEncryptionKekVersion: newFileStorageContext.fileEncryptionKekVersion,
      fileEncryptionKeyWrapped: newFileStorageContext.fileEncryptionKeyWrapped,
      mimeType,
      originalSha256Hash: hash,
    }),
  );

  if (error) {
    logger.error({ error }, 'Error while creating document');

    // If the document is not saved, delete the file from the storage
    await documentsStorageService.deleteFile({ storageKey: newFileStorageContext.storageKey });

    logger.error({ error }, 'Stored document file deleted because of error');

    throw error;
  }

  const { document } = result;

  if (isContentExtractionEnabled) {
    await taskServices.scheduleJob({
      taskName: 'extract-document-file-content',
      data: { documentId, organizationId, ocrLanguages },
    });
  }

  logger.info({ documentId, userId, organizationId, mimeType }, 'Document created');

  return { document };
}

export async function getDocumentOrThrow({
  documentId,
  organizationId,
  documentsRepository,
}: {
  documentId: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
}) {
  const { document } = await documentsRepository.getDocumentById({ documentId, organizationId });

  if (!document) {
    throw createDocumentNotFoundError();
  }

  return { document };
}

export async function ensureDocumentExists({
  documentId,
  organizationId,
  documentsRepository,
}: {
  documentId: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
}) {
  await getDocumentOrThrow({ documentId, organizationId, documentsRepository });
}

export async function hardDeleteDocument({
  document,
  documentsRepository,
  documentsStorageService,
  eventServices,
}: {
  document: Pick<Document, 'id' | 'originalStorageKey' | 'organizationId'>;
  documentsRepository: DocumentsRepository;
  documentsStorageService: StorageService;
  eventServices: EventServices;
}) {
  await Promise.all([
    documentsRepository.hardDeleteDocument({ documentId: document.id }),
    documentsStorageService.deleteFile({ storageKey: document.originalStorageKey }),
  ]);

  eventServices.emitEvent({
    eventName: 'document.deleted',
    payload: { documentId: document.id, organizationId: document.organizationId },
  });
}

export async function deleteExpiredDocuments({
  documentsRepository,
  documentsStorageService,
  eventServices,
  config,
  now = new Date(),
  logger = createLogger({ namespace: 'documents:deleteExpiredDocuments' }),
}: {
  documentsRepository: DocumentsRepository;
  documentsStorageService: StorageService;
  eventServices: EventServices;
  config: Config;
  now?: Date;
  logger?: Logger;
}) {
  const { documents } = await documentsRepository.getExpiredDeletedDocuments({
    expirationDelayInDays: config.documents.deletedDocumentsRetentionDays,
    now,
  });

  const limit = pLimit(10);

  await Promise.all(
    documents.map(async (document) =>
      limit(async () => {
        const [, error] = await safely(
          hardDeleteDocument({
            document,
            documentsRepository,
            documentsStorageService,
            eventServices,
          }),
        );

        if (error) {
          logger.error({ document, error }, 'Error while deleting expired document');
        }
      }),
    ),
  );

  return {
    deletedDocumentsCount: documents.length,
  };
}

export async function deleteTrashDocument({
  documentId,
  organizationId,
  documentsRepository,
  documentsStorageService,
  eventServices,
}: {
  documentId: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: StorageService;
  eventServices: EventServices;
}) {
  const { document } = await documentsRepository.getDocumentById({ documentId, organizationId });

  if (!document) {
    throw createDocumentNotFoundError();
  }

  if (!document.isDeleted) {
    throw createDocumentNotDeletedError();
  }

  await hardDeleteDocument({
    document,
    documentsRepository,
    documentsStorageService,
    eventServices,
  });
}

export async function deleteAllTrashDocuments({
  organizationId,
  documentsRepository,
  documentsStorageService,
  eventServices,
}: {
  organizationId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: StorageService;
  eventServices: EventServices;
}) {
  const { documents } = await documentsRepository.getAllOrganizationTrashDocuments({
    organizationId,
  });

  // TODO: refactor to use batching and transaction

  const limit = pLimit(10);

  await Promise.all(
    documents.map(async (document) =>
      limit(async () => {
        await hardDeleteDocument({
          document,
          documentsRepository,
          documentsStorageService,
          eventServices,
        });
      }),
    ),
  );
}

export async function extractAndSaveDocumentFileContent({
  documentId,
  organizationId,
  documentsRepository,
  documentsStorageService,
  taggingRulesRepository,
  tagsRepository,
  eventServices,
  extractDocumentText,
  customPropertiesRepository,
  customPropertiesOptionsRepository,
  organizationsRepository,
  config,
}: {
  documentId: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: StorageService;
  taggingRulesRepository: TaggingRulesRepository;
  tagsRepository: TagsRepository;
  eventServices: EventServices;
  extractDocumentText: ExtractDocumentTextUsecase;
  customPropertiesRepository: CustomPropertiesRepository;
  customPropertiesOptionsRepository: CustomPropertiesOptionsRepository;
  organizationsRepository: OrganizationsRepository;
  config: Config;
}) {
  const { document } = await documentsRepository.getDocumentById({ documentId, organizationId });

  if (!document) {
    throw createDocumentNotFoundError();
  }

  const { fileStream } = await documentsStorageService.getFileStream({
    storageKey: document.originalStorageKey,
    fileEncryptionAlgorithm: document.fileEncryptionAlgorithm,
    fileEncryptionKekVersion: document.fileEncryptionKekVersion,
    fileEncryptionKeyWrapped: document.fileEncryptionKeyWrapped,
  });

  const { file } = await collectStreamToFile({
    fileStream,
    fileName: document.name,
    mimeType: document.mimeType,
  });

  const { text, metadata } = await extractDocumentText({ file });

  const updateChanges: { content?: string; name?: string; documentDate?: Date | null } = {
    content: text,
  };

  // Apply metadata from extraction (if available). The extracted title only
  // becomes the document name while the document still carries its original
  // file name, so re-extracting a user-renamed document never overwrites the
  // user's choice; it is also clamped to the same length limit the update
  // route enforces. The extracted date only fills an unset documentDate, and
  // is validated so unparseable model output never writes an invalid date.
  if (metadata) {
    const extractedTitle = metadata.title?.trim();

    if (extractedTitle && document.name === document.originalName) {
      updateChanges.name = extractedTitle.slice(0, documentNameMaxLength);
    }

    const parsedDate = metadata.date ? new Date(metadata.date) : null;
    if (parsedDate && !isNaN(parsedDate.getTime()) && isNil(document.documentDate)) {
      updateChanges.documentDate = parsedDate;
    }
  }

  const { document: updatedDocument } = await updateDocument({
    documentId,
    organizationId,
    changes: updateChanges,
    documentsRepository,
    eventServices,
  });

  if (isNil(updatedDocument)) {
    // This should never happen, but for type safety
    throw createDocumentNotFoundError();
  }

  // Apply metadata as a best-effort enhancement: a failure to tag or set a
  // custom property should not fail the whole extraction (the text is already
  // saved). Tagging uses the same conventions as auto-tagging (org limit check,
  // webhook + activity events).
  try {
    const tags = metadata?.tags ?? [];
    if (tags.length > 0) {
      await applyExtractionTags({
        documentId,
        organizationId,
        tags,
        tagsRepository,
        eventServices,
        config,
      });
    }

    const fields = metadata?.fields ?? {};
    if (Object.keys(fields).length > 0) {
      const { propertyDefinitions: customProperties } =
        await customPropertiesRepository.getOrganizationPropertyDefinitions({
          organizationId,
        });

      await applyExtractionCustomProperties({
        documentId,
        organizationId,
        fields,
        customProperties,
        customPropertiesRepository,
        customPropertiesOptionsRepository,
        organizationsRepository,
        documentsRepository,
      });
    }
  } catch (error) {
    createLogger({ namespace: 'extractAndSaveDocumentFileContent' }).error(
      { documentId, organizationId, error },
      'Failed to apply extraction metadata (tags/custom properties)',
    );
  }

  // Apply existing tagging rules (may add additional tags)
  await applyTaggingRules({
    document: updatedDocument,
    taggingRulesRepository,
    tagsRepository,
    eventServices,
  });

  return { document: updatedDocument };
}

async function applyExtractionTags({
  documentId,
  organizationId,
  tags,
  tagsRepository,
  eventServices,
  config,
}: {
  documentId: string;
  organizationId: string;
  tags: TagInput[];
  tagsRepository: TagsRepository;
  eventServices: EventServices;
  config: Config;
}): Promise<void> {
  // The tag caps live on the AI strategy config; they apply to any strategy
  // emitting metadata (the AI prompt already caps suggestions at maxTags, this
  // re-applies the cap defensively at write time).
  const { maxTags, allowNewTags } = config.documentContentExtraction.strategy.ai;

  const { tags: existingTags } = await tagsRepository.getOrganizationTags({ organizationId });

  const { tagIdsToAdd, tagsToCreate } = buildExtractionTagActions({
    tags,
    existingTags,
    allowNewTags,
    maxTags,
  });

  if (tagIdsToAdd.length === 0 && tagsToCreate.length === 0) {
    return;
  }

  // Same convention as auto-tagging: best-effort creation of unknown tags,
  // then a single tag application so webhook and activity events fire once.
  await createTagsAndApplyToDocuments({
    documentIds: [documentId],
    organizationId,
    tagIdsToAdd,
    tagsToCreate,
    config,
    tagsRepository,
    eventServices,
  });
}

async function applyExtractionCustomProperties({
  documentId,
  organizationId,
  fields,
  customProperties,
  customPropertiesRepository,
  customPropertiesOptionsRepository,
  organizationsRepository,
  documentsRepository,
  logger = createLogger({ namespace: 'extractAndSaveDocumentFileContent' }),
}: {
  documentId: string;
  organizationId: string;
  fields: Record<string, string>;
  customProperties: Array<{
    id: string;
    key: string;
    name: string;
    type: CustomPropertyType;
    options: Array<{ id: string; name: string; key: string }>;
  }>;
  customPropertiesRepository: CustomPropertiesRepository;
  customPropertiesOptionsRepository: CustomPropertiesOptionsRepository;
  organizationsRepository: OrganizationsRepository;
  documentsRepository: DocumentsRepository;
  logger?: Logger;
}): Promise<void> {
  // Build a lookup map for custom properties by key and name
  const propertyMap = new Map<string, (typeof customProperties)[0]>();
  for (const cp of customProperties) {
    propertyMap.set(cp.key.toLowerCase(), cp);
    propertyMap.set(cp.name.toLowerCase(), cp);
  }

  for (const [fieldKey, fieldValue] of Object.entries(fields)) {
    const normalizedKey = fieldKey.toLowerCase().replace(/[\s_]+/g, '-');
    const property = propertyMap.get(normalizedKey) ?? propertyMap.get(fieldKey.toLowerCase());

    if (!property) {
      continue; // No matching custom property definition
    }

    // Parse the model string into the plain value the property type expects
    const value = parseValueForPropertyType(fieldValue, property);
    if (value === null) {
      continue;
    }

    // Go through the same usecase as the API route so type validation
    // (input schemas, option/relation existence, value size limits) stays
    // single-sourced. Each field is applied best-effort: one invalid value
    // must not prevent the remaining fields from being set.
    const [, error] = await safely(async () =>
      setDocumentCustomPropertyValue({
        documentId,
        organizationId,
        propertyDefinitionId: property.id,
        value,
        customPropertiesRepository,
        customPropertiesOptionsRepository,
        organizationsRepository,
        documentsRepository,
      }),
    );

    if (error) {
      logger.warn(
        { documentId, organizationId, fieldKey, propertyDefinitionId: property.id, error },
        'Skipped extraction custom property value (validation failed)',
      );
    }
  }
}

export async function trashDocument({
  documentId,
  organizationId,
  userId,
  documentsRepository,
  eventServices,
}: {
  documentId: string;
  organizationId: string;
  userId: string;
  documentsRepository: DocumentsRepository;
  eventServices: EventServices;
}) {
  await documentsRepository.softDeleteDocument({ documentId, organizationId, userId });

  eventServices.emitEvent({
    eventName: 'documents.trashed',
    payload: { documentIds: [documentId], organizationId, trashedBy: userId },
  });
}

export async function restoreDocument({
  documentId,
  organizationId,
  userId,
  documentsRepository,
  eventServices,
}: {
  documentId: string;
  organizationId: string;
  userId: string;
  documentsRepository: DocumentsRepository;
  eventServices: EventServices;
}) {
  await documentsRepository.restoreDocument({ documentId, organizationId });

  eventServices.emitEvent({
    eventName: 'document.restored',
    payload: { documentId, organizationId, restoredBy: userId },
  });
}

export async function enrichAndFormatDocumentsForApi({
  documents,
  tagsRepository,
  customPropertiesRepository,
}: {
  documents: Array<PartialBy<Document, 'content'>>;
  tagsRepository: TagsRepository;
  customPropertiesRepository: CustomPropertiesRepository;
}) {
  if (documents.length === 0) {
    return { enrichedDocuments: [] };
  }

  const { organizationId } = documents[0] ?? {};

  if (isNil(organizationId)) {
    throw createError({
      message: 'Organization ID is required to enrich documents',
      code: 'organization_id_required',
      statusCode: 500,
    });
  }

  const uniqueOrganizationIds = new Set(documents.map((d) => d.organizationId));

  if (uniqueOrganizationIds.size > 1) {
    throw createError({
      message: 'All documents must belong to the same organization to be enriched',
      code: 'multiple_organization_ids',
      statusCode: 500,
    });
  }

  const documentIds = documents.map((d) => d.id);

  const [{ tagsByDocumentId }, { valuesByDocumentId }, { propertyDefinitions }] = await Promise.all(
    [
      tagsRepository.getTagsByDocumentIds({ documentIds }),
      customPropertiesRepository.getCustomPropertyValuesByDocumentIds({ documentIds }),
      customPropertiesRepository.getOrganizationPropertyDefinitions({ organizationId }),
    ],
  );

  return {
    enrichedDocuments: documents.map((document) => ({
      ...formatDocumentForApi({ document }),
      tags: tagsByDocumentId[document.id] ?? [],
      customProperties: buildCustomPropertiesArray({
        rawValues: valuesByDocumentId[document.id] ?? [],
        propertyDefinitions,
      }),
    })),
  };
}

export async function enrichAndFormatDocumentForApi({
  document,
  tagsRepository,
  customPropertiesRepository,
}: {
  document: PartialBy<Document, 'content'>;
  tagsRepository: TagsRepository;
  customPropertiesRepository: CustomPropertiesRepository;
}) {
  const { enrichedDocuments } = await enrichAndFormatDocumentsForApi({
    documents: [document],
    tagsRepository,
    customPropertiesRepository,
  });

  const [enrichedDocument] = enrichedDocuments;

  if (!enrichedDocument) {
    // This should never happen, but for type safety
    throw createError({
      message: 'Document enrichment failed',
      code: 'document_enrichment_failed',
      statusCode: 500,
    });
  }

  return { enrichedDocument };
}

export async function updateDocument({
  documentId,
  organizationId,
  userId,
  documentsRepository,
  eventServices,
  changes,
}: {
  documentId: string;
  organizationId: string;
  userId?: string;
  documentsRepository: DocumentsRepository;
  eventServices: EventServices;
  changes: {
    name?: string;
    content?: string;
    documentDate?: Date | null;
    notes?: string;
  };
}) {
  // It throws if the document does not exist
  const { document } = await documentsRepository.updateDocument({
    documentId,
    organizationId,
    ...changes,
  });

  eventServices.emitEvent({
    eventName: 'document.updated',
    payload: { userId, changes, document },
  });

  return { document };
}
