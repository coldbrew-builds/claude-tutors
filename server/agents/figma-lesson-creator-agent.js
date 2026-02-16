const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ClaudeService = require('../services/claude-service');
const GeminiImageService = require('../services/gemini-image');
const logger = require('../utils/logger');

const TAG = 'FigmaLessonCreator';

class FigmaLessonCreatorAgent {
  constructor() {
    this.config = require('./figma-lesson-creator.json');
    const imgConfig = this.config.imageGeneration || {};

    this.claude = new ClaudeService(process.env.ANTHROPIC_API_KEY);
    this.gemini = new GeminiImageService(process.env.GOOGLE_GENAI_API_KEY, imgConfig.model);

    // Image mode: "off" | "reference-only" | "full"
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

  _getAspectRatio(objectLabel) {
    const label = objectLabel.toLowerCase();
    const mobileKeywords = ['mobile', 'phone', 'app ', 'ios', 'android', 'app home'];
    if (mobileKeywords.some(kw => label.includes(kw))) return '9:16';
    return '3:4';
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

    const simplicityNote = proficiency === 'beginner'
      ? '\nIMPORTANT: Keep it very simple. Each section should have only 2-3 elements (e.g., a rectangle and a text label). Avoid complex nested layouts, multiple columns of cards, or detailed content. Think big simple blocks, not detailed UI.'
      : '';

    if (hasImage) {
      return `Analyze the UI design "${objectLabel}" for a ${proficiency} Figma user.
Look at the reference image and break the design down into ${subPieces} buildable UI sections, ordered from structural (outer frames, page layout) to detail (content, styling).${simplicityNote}

Respond with ONLY valid JSON in this exact format:
{
  "subPieces": [
    {
      "name": "section name",
      "buildDescription": "brief description of this UI section and its layout",
      "operations": ["operation1", "operation2"]
    }
  ]
}`;
    }

    return `Analyze the UI design "${objectLabel}" for a ${proficiency} Figma user.
Think about the typical structure and layout of a ${objectLabel}. Use only simple Figma elements: frames, rectangles, and text.

Break it down into ${subPieces} buildable UI sections, ordered from structural (outer frames, page layout) to detail (content, styling).
For each section, describe its layout approach (auto-layout direction, gap, padding) and the few key elements needed.${simplicityNote}

Respond with ONLY valid JSON in this exact format:
{
  "subPieces": [
    {
      "name": "section name",
      "buildDescription": "brief description including layout direction and key elements",
      "operations": ["operation1", "operation2"]
    }
  ]
}`;
  }

  _buildInstructionPrompt(objectLabel, proficiency, piece, stepNumber, totalSteps) {
    const { subSteps } = this._getStepCounts(proficiency);

    return `Write a clear, step-by-step Figma instruction for a ${proficiency} user to build the "${piece.name}" section of a ${objectLabel}.

Section: ${piece.name}
Description: ${piece.buildDescription}
Operations: ${piece.operations.join(', ')}
Step number: ${stepNumber} of ${totalSteps}

Write ${subSteps} numbered sub-steps. Be specific about:
- Frame dimensions and auto-layout settings (direction, gap, padding)
- Fill colors (use hex values), corner radius, and effects
- Text properties (font, size, weight, color)
- Constraints and responsive behavior
- Relevant Figma shortcuts (F for frame, A for auto-layout, T for text, R for rectangle)
Keep it concise.`;
  }

  async generate(objectLabel, proficiency) {
    const sessionId = uuidv4().slice(0, 8);
    const outputDir = path.join(__dirname, '..', '..', 'output', 'tutorials', sessionId);
    fs.mkdirSync(outputDir, { recursive: true });

    const aspectRatio = this._getAspectRatio(objectLabel);
    logger.info(TAG, `Generating tutorial: "${objectLabel}" (${proficiency}, images=${this.imageMode}, aspect=${aspectRatio}) -> ${outputDir}`);

    // Phase 1: Generate reference image (if mode is "reference-only" or "full")
    let referenceImage = null;
    if (this.generateReferenceImage) {
      logger.info(TAG, 'Phase 1: Generating reference image...');
      try {
        referenceImage = await this._generateReferenceImage(objectLabel, outputDir, aspectRatio);
      } catch (err) {
        logger.error(TAG, 'Reference image generation failed:', err.message);
      }
    }

    // Phase 2: Analyze design with Claude to get sections
    logger.info(TAG, 'Phase 2: Analyzing design with Claude...');
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
        { name: objectLabel, buildDescription: `Build the ${objectLabel}`, operations: ['Create frame', 'Add elements'] }
      ];
    }

    logger.info(TAG, `Found ${subPieces.length} sections`);

    // Phase 3: Generate step images + instructions in parallel
    logger.info(TAG, 'Phase 3: Generating steps...');

    const steps = await Promise.all(subPieces.map(async (piece, idx) => {
      const stepNumber = idx + 1;

      // Generate step image (only in "full" mode)
      let stepImage = null;
      if (this.generateStepImages) {
        try {
          stepImage = await this._generateStepImage(
            objectLabel, piece.name, piece.buildDescription, stepNumber, outputDir, aspectRatio
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
        figmaOperations: piece.operations
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

  async _generateReferenceImage(objectLabel, outputDir, aspectRatio) {
    const prompt = `Create a simple, flat UI mockup of a "${objectLabel}" design.
Use solid colored rectangles and blocks — light blue for headers, light gray for content areas, darker rectangles for buttons, medium gray for image placeholders.
Clean flat design with solid fills, no outlines, no sketchy lines, no hand-drawn style.
This is NOT a screenshot of any software — do NOT show any application chrome, toolbars, menus, or side panels.
Show only the UI layout itself on a plain white background. Keep it minimal with just 3-5 major sections using simple solid shapes.`;

    return this.gemini.generateImage(prompt, outputDir, 'reference.png', { aspectRatio });
  }

  async _generateStepImage(objectLabel, sectionName, description, stepNumber, outputDir, aspectRatio) {
    const prompt = `Show step ${stepNumber} of building a "${objectLabel}" UI design.
This step focuses on: ${sectionName} - ${description}
Show the progressive build state using simple solid colored blocks and shapes.
Use solid fills — light blue for headers, light gray for content areas, darker rectangles for buttons.
Clean flat design, no outlines, no sketchy lines. Plain white background.
This is NOT a screenshot of any software — no application chrome or toolbars.
Include a small label "Step ${stepNumber}: ${sectionName}".`;

    return this.gemini.generateImage(prompt, outputDir, `step_${stepNumber}.png`, { aspectRatio });
  }
}

module.exports = FigmaLessonCreatorAgent;
