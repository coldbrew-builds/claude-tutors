const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const TAG = 'Gemini';

class GeminiImageService {
  constructor(apiKey, model) {
    this.genAI = new GoogleGenAI({ apiKey });
    this.model = model || 'gemini-3-pro-image-preview';
  }

  async generateImage(prompt, outputDir, filename, { aspectRatio } = {}) {
    fs.mkdirSync(outputDir, { recursive: true });

    logger.info(TAG, `Generating image: ${filename} (model=${this.model}${aspectRatio ? `, aspect=${aspectRatio}` : ''})`);
    logger.debug(TAG, `Prompt: ${prompt.substring(0, 100)}...`);

    const config = {
      responseModalities: ['image', 'text'],
    };
    if (aspectRatio) {
      config.imageConfig = { aspectRatio };
    }

    const response = await this.genAI.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config
    });

    // Extract image from response
    const parts = response.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData);

    if (!imagePart) {
      logger.warn(TAG, 'No image in response, text-only fallback');
      return null;
    }

    const base64Data = imagePart.inlineData.data;
    const mimeType = imagePart.inlineData.mimeType || 'image/png';
    const filePath = path.join(outputDir, filename);

    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    logger.info(TAG, `Image saved: ${filePath} (${mimeType})`);

    const relativePath = path.relative(path.join(__dirname, '..', '..'), filePath);

    return { filePath, base64Data, mimeType, relativePath };
  }

  async generateReferenceImage(objectLabel, outputDir) {
    const prompt = `Create a 2x2 grid showing a ${objectLabel} from 4 different angles (front, side, top, 3/4 view).
Use a simple, clean 3D primitive shapes style - like basic geometric forms (cubes, cylinders, spheres) composed together.
White/light gray background. Minimalist style suitable for a 3D modeling tutorial reference sheet.
Label each view angle. The object should look like it's made from basic 3D primitives.`;

    return this.generateImage(prompt, outputDir, 'reference.png');
  }

  async generateStepImage(objectLabel, subPiece, description, stepNumber, outputDir) {
    const prompt = `Show step ${stepNumber} of building a ${objectLabel} in a 3D modeling style.
This step focuses on: ${subPiece} - ${description}
Show the progressive build state - what the model looks like at this point.
Use simple 3D primitive shapes style (cubes, cylinders, spheres).
Clean white/light gray background. Include a small label "Step ${stepNumber}: ${subPiece}".
Minimalist, clear, instructional style.`;

    return this.generateImage(prompt, outputDir, `step_${stepNumber}.png`);
  }
}

module.exports = GeminiImageService;
