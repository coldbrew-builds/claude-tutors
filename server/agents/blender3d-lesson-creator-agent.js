const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ClaudeService = require('../services/claude-service');
const GeminiImageService = require('../services/gemini-image');
const logger = require('../utils/logger');

const TAG = 'LessonCreator';

class LessonCreatorAgent {
  constructor() {
    this.config = require('./blender3d-lesson-creator.json');
    const imgConfig = this.config.imageGeneration || {};

    this.claude = new ClaudeService(process.env.ANTHROPIC_API_KEY);
    this.gemini = new GeminiImageService(process.env.GOOGLE_GENAI_API_KEY, imgConfig.model);

    // Image mode: "off" | "reference-only" | "full"
    // Backwards-compat: old boolean `enabled` maps to "full" / "off"
    if (imgConfig.mode) {
      this.imageMode = imgConfig.mode;
    } else {
      this.imageMode = imgConfig.enabled === false ? 'off' : 'full';
    }
  }

  get generateReferenceImage() {
    return this.imageMode === 'reference-only' || this.imageMode === 'full';
  }

  get generateStepImages() {
    return this.imageMode === 'full';
  }

  _getStepCounts(proficiency) {
    const defaults = {
      beginner:     { subPieces: '3-4', subSteps: '2-3' },
      intermediate: { subPieces: '4-6', subSteps: '3-4' },
      advanced:     { subPieces: '5-8', subSteps: '3-5' }
    };
    const counts = this.config.stepCounts || defaults;
    return counts[proficiency] || defaults.intermediate;
  }

  _buildAnalysisPrompt(objectLabel, proficiency, hasImage) {
    const { subPieces } = this._getStepCounts(proficiency);

    if (hasImage) {
      // Claude can see the reference image — lean on visual context
      return `Analyze the 3D object "${objectLabel}" for a ${proficiency} Blender user.
Look at the reference image and break the object down into ${subPieces} buildable sub-pieces, ordered from foundational to detail.

Respond with ONLY valid JSON in this exact format:
{
  "subPieces": [
    {
      "name": "piece name",
      "buildDescription": "brief description of what this piece is",
      "operations": ["operation1", "operation2"]
    }
  ]
}`;
    }

    // No image — give Claude richer text guidance to compensate
    return `Analyze the 3D object "${objectLabel}" for a ${proficiency} Blender user.
Think about the typical real-world shape and proportions of a ${objectLabel}. Consider which basic Blender primitives (cube, cylinder, sphere, cone, plane, torus) best approximate each part.

Break it down into ${subPieces} buildable sub-pieces, ordered from foundational to detail.
For each sub-piece, describe its approximate shape, relative size, and position on the object.

Respond with ONLY valid JSON in this exact format:
{
  "subPieces": [
    {
      "name": "piece name",
      "buildDescription": "brief description including shape, approximate proportions, and position",
      "operations": ["operation1", "operation2"]
    }
  ]
}`;
  }

  _buildInstructionPrompt(objectLabel, proficiency, piece, stepNumber, totalSteps) {
    const { subSteps } = this._getStepCounts(proficiency);

    return `Write a clear, step-by-step Blender instruction for a ${proficiency} user to build the "${piece.name}" sub-piece of a ${objectLabel}.

Sub-piece: ${piece.name}
Description: ${piece.buildDescription}
Operations: ${piece.operations.join(', ')}
Step number: ${stepNumber} of ${totalSteps}

Write ${subSteps} numbered sub-steps. Be specific about which tools, hotkeys, and values to use. Keep it concise.`;
  }

  async generate(objectLabel, proficiency) {
    const sessionId = uuidv4().slice(0, 8);
    const outputDir = path.join(__dirname, '..', '..', 'output', 'tutorials', sessionId);
    fs.mkdirSync(outputDir, { recursive: true });

    logger.info(TAG, `Generating tutorial: "${objectLabel}" (${proficiency}, images=${this.imageMode}) → ${outputDir}`);

    // Phase 1: Generate reference image (if mode is "reference-only" or "full")
    let referenceImage = null;
    if (this.generateReferenceImage) {
      logger.info(TAG, 'Phase 1: Generating reference image...');
      try {
        referenceImage = await this.gemini.generateReferenceImage(objectLabel, outputDir);
      } catch (err) {
        logger.error(TAG, 'Reference image generation failed:', err.message);
      }
    }

    // Phase 2: Analyze object with Claude to get sub-pieces
    logger.info(TAG, 'Phase 2: Analyzing object with Claude...');
    const analysisPrompt = this._buildAnalysisPrompt(objectLabel, proficiency, !!referenceImage);
    const analysisMessages = [{ role: 'user', content: analysisPrompt }];
    const images = referenceImage ? [{ data: referenceImage.base64Data, mediaType: referenceImage.mimeType || 'image/png' }] : [];

    const analysisResponse = await this.claude.getResponse(
      this.config.systemPrompt,
      analysisMessages,
      [],
      images
    );

    const analysisText = analysisResponse.content.find(c => c.type === 'text')?.text || '';
    let subPieces;
    try {
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch[0]);
      subPieces = parsed.subPieces;
    } catch (err) {
      logger.error(TAG, 'Failed to parse sub-pieces JSON:', err.message);
      subPieces = [
        { name: objectLabel, buildDescription: `Build the ${objectLabel}`, operations: ['Add mesh', 'Shape it'] }
      ];
    }

    logger.info(TAG, `Found ${subPieces.length} sub-pieces`);

    // Phase 3: Generate step images + instructions in parallel
    logger.info(TAG, 'Phase 3: Generating steps...');

    const steps = await Promise.all(subPieces.map(async (piece, idx) => {
      const stepNumber = idx + 1;

      // Generate step image (only in "full" mode)
      let stepImage = null;
      if (this.generateStepImages) {
        try {
          stepImage = await this.gemini.generateStepImage(
            objectLabel, piece.name, piece.buildDescription, stepNumber, outputDir
          );
        } catch (err) {
          logger.error(TAG, `Step ${stepNumber} image failed:`, err.message);
        }
      }

      // Generate detailed instruction
      const instructionPrompt = this._buildInstructionPrompt(
        objectLabel, proficiency, piece, stepNumber, subPieces.length
      );

      const instructionResponse = await this.claude.getResponse(
        this.config.systemPrompt,
        [{ role: 'user', content: instructionPrompt }]
      );

      const instruction = instructionResponse.content.find(c => c.type === 'text')?.text || '';

      return {
        stepNumber,
        title: piece.name,
        instruction,
        imagePath: stepImage ? `/output/tutorials/${sessionId}/step_${stepNumber}.png` : null,
        blenderOperations: piece.operations
      };
    }));

    const tutorial = {
      objectLabel,
      proficiency,
      referenceImagePath: referenceImage ? `/output/tutorials/${sessionId}/reference.png` : null,
      totalSteps: steps.length,
      steps,
      metadata: {
        sessionId,
        generatedAt: new Date().toISOString(),
        imageMode: this.imageMode
      }
    };

    logger.info(TAG, `Tutorial complete: ${tutorial.totalSteps} steps`);
    return tutorial;
  }
}

module.exports = LessonCreatorAgent;
