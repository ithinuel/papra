import type { Database } from '../../app/database/database.types';
import type { EventServices } from '../../app/events/events.services';
import type { TaskServices } from '../../tasks/tasks.services';
import type { StorageService } from '../../storage/storage.services';
import { createTaggingRulesRepository } from '../../tagging-rules/tagging-rules.repository';
import { createTagsRepository } from '../../tags/tags.repository';
import { createCustomPropertiesRepository } from '../../custom-properties/custom-properties.repository';
import { createCustomPropertiesOptionsRepository } from '../../custom-properties/options/custom-properties-options.repository';
import { createOrganizationsRepository } from '../../organizations/organizations.repository';
import { createDocumentsRepository } from '../documents.repository';
import { extractAndSaveDocumentFileContent } from '../documents.usecases';
import type { Config } from '../../config/config.types';
import { buildExtractDocumentTextUsecase } from '../content-extraction/content-extraction.usecases';
import type { ChatDependencies } from '../../ai/ai.chat.usecases';
import type { ContentExtractionRunContext } from '../content-extraction/content-extraction-strategies/content-extraction-strategies.types';
import { CONTENT_EXTRACTION_STRATEGIES } from '../content-extraction/content-extraction-strategies/content-extraction-strategies.constants';

export async function registerExtractDocumentFileContentTask({
  taskServices,
  db,
  documentsStorageService,
  eventServices,
  config,
  chatDependencies,
}: {
  taskServices: TaskServices;
  db: Database;
  documentsStorageService: StorageService;
  eventServices: EventServices;
  config: Config;
  chatDependencies: ChatDependencies;
}) {
  const taskName = 'extract-document-file-content';

  taskServices.registerTask({
    taskName,
    // Extraction is idempotent (the content row is overwritten), so transient
    // upstream failures — provider 429s, render/chat timeouts, every strategy
    // in the fallback chain failing — are worth retrying instead of leaving a
    // document without content.
    options: { maxRetries: 2, retryBackoff: 'exponential' },
    handler: async ({ data }) => {
      const documentsRepository = createDocumentsRepository({ db });
      const taggingRulesRepository = createTaggingRulesRepository({ db });
      const tagsRepository = createTagsRepository({ db });
      const customPropertiesRepository = createCustomPropertiesRepository({ db });
      const customPropertiesOptionsRepository = createCustomPropertiesOptionsRepository({ db });
      const organizationsRepository = createOrganizationsRepository({ db });

      // TODO: remove type cast
      const { documentId, organizationId, ocrLanguages } = data as {
        documentId: string;
        organizationId: string;
        ocrLanguages: string[];
      };

      // The AI strategy needs the document, the organization's tags and its
      // custom-property definitions to build prompts. Other strategies ignore
      // the run context, so only pay for these lookups when `ai` is configured.
      const aiStrategyConfigured = config.documentContentExtraction.extractionStrategies.includes(
        CONTENT_EXTRACTION_STRATEGIES.ai,
      );

      let runContext: ContentExtractionRunContext | undefined;

      if (aiStrategyConfigured) {
        const { document } = await documentsRepository.getDocumentById({
          documentId,
          organizationId,
        });

        if (!document) {
          throw new Error(`Document ${documentId} not found in organization ${organizationId}`);
        }

        const [{ tags }, { propertyDefinitions: customProperties }] = await Promise.all([
          tagsRepository.getOrganizationTags({ organizationId }),
          customPropertiesRepository.getOrganizationPropertyDefinitions({ organizationId }),
        ]);

        runContext = { document, tags, customProperties };
      }

      const extractDocumentText = buildExtractDocumentTextUsecase({
        ocrLanguages,
        config,
        runContext,
        chatDeps: chatDependencies,
      });

      await extractAndSaveDocumentFileContent({
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
      });

      if (!config.ai.isEnabled || !config.autoTagging.isEnabled) {
        return;
      }

      await taskServices.scheduleJob({
        taskName: 'auto-tag-document',
        data: { documentId, organizationId },
      });
    },
  });
}
