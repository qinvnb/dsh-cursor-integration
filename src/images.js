import {ProviderError} from './provider.js';

export async function imagePrompt(options, services) {
  const transformed = [], images = [], attachments = new Map();
  for (const original of options.messages) {
    const content = [];
    for (const part of original.content) {
      if (options.signal?.aborted) throw new ProviderError('ABORTED','Request cancelled');
      if (part.type !== 'image') {
        content.push(part);
      } else if (part.offloaded) {
        content.push({type:'text',text:services.offloadedImageText(part.attachment)});
      } else {
        if (!services.attachments) throw new ProviderError('IMAGE_STORE_UNAVAILABLE','Image storage is unavailable');
        const reference = part.attachment;
        let file = attachments.get(reference.attachmentId);
        if (!file) {
          try {file = await services.attachments.readImage(reference,options.signal);}
          catch {
            throw new ProviderError(options.signal?.aborted ? 'ABORTED' : 'IMAGE_READ_FAILED','Image attachment could not be read');
          }
          attachments.set(reference.attachmentId,file);
        }
        if (options.signal?.aborted) throw new ProviderError('ABORTED','Request cancelled');
        images.push({
          data:Buffer.from(file.data).toString('base64'),mimeType:reference.mediaType,
          dimension:{width:reference.width,height:reference.height},
        });
        content.push({...part,sdkImage:images.length});
      }
    }
    transformed.push({...original,content});
  }
  return {images,messages:transformed};
}
