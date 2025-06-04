import * as vscode from "vscode"
import { buildApiHandler, ApiHandler } from "../../api"
import { CodeContext, ContextGatherer } from "./ContextGatherer"
import { holeFillerTemplate } from "./templating/AutocompleteTemplate"
import { ContextProxy } from "../../core/config/ContextProxy"
import { generateImportSnippets, generateDefinitionSnippets } from "./context/snippetProvider"
import { AutocompleteCache } from "./cache/AutocompleteCache"
import { createDebouncedFn } from "./utils/createDebouncedFn"
import { AutocompleteDecorationAnimation } from "./AutocompleteDecorationAnimation"
import { isHumanEdit } from "./utils/EditDetectionUtils"
import { ExperimentId } from "@roo-code/types"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { processTextInsertion, InsertionContext } from "./utils/CompletionTextProcessor"
import { AutocompleteStatusBar } from "./AutocompleteStatusBar"
import { AutocompleteState } from "./types"
import { formatCost } from "./utils/costFormatting"

export const UI_UPDATE_DEBOUNCE_MS = 250
export const BAIL_OUT_TOO_MANY_LINES_LIMIT = 100

// const DEFAULT_MODEL = "mistralai/codestral-2501"
const DEFAULT_MODEL = "google/gemini-2.5-flash-preview-05-20"

export function processModelResponse(responseText: string): string {
	const fullMatch = /(<COMPLETION>)?([\s\S]*?)(<\/COMPLETION>|$)/.exec(responseText)
	if (!fullMatch) {
		return responseText
	}
	if (fullMatch[2].endsWith("</COMPLETION>")) {
		return fullMatch[2].slice(0, -"</COMPLETION>".length)
	}
	return fullMatch[2]
}

/**
 * Sets up autocomplete with experiment flag checking.
 * This function periodically checks the experiment flag and registers/disposes
 * the autocomplete provider accordingly.
 */
export function registerAutocomplete(context: vscode.ExtensionContext): void {
	let autocompleteDisposable: vscode.Disposable | null = null
	let isCurrentlyEnabled = false

	// Function to check experiment flag and update provider
	const checkAndUpdateProvider = () => {
		const experiments =
			(ContextProxy.instance?.getGlobalState("experiments") as Record<ExperimentId, boolean>) ?? {}
		const shouldBeEnabled = experiments.autocomplete ?? false

		// Only take action if the state has changed
		if (shouldBeEnabled !== isCurrentlyEnabled) {
			console.log(`🚀🔍 Autocomplete experiment flag changed to: ${shouldBeEnabled}`)

			autocompleteDisposable?.dispose()
			autocompleteDisposable = shouldBeEnabled ? setupAutocomplete(context) : null
			isCurrentlyEnabled = shouldBeEnabled
		}
	}

	checkAndUpdateProvider()
	const experimentCheckInterval = setInterval(checkAndUpdateProvider, 5000)

	// Make sure to clean up the interval when the extension is deactivated
	context.subscriptions.push({
		dispose: () => {
			clearInterval(experimentCheckInterval)
			autocompleteDisposable?.dispose()
		},
	})
}

function setupAutocomplete(context: vscode.ExtensionContext): vscode.Disposable {
	const state: AutocompleteState = {
		enabled: true,
		lastCompletionCost: 0,
		totalSessionCost: 0,
		model: DEFAULT_MODEL,
		hasValidToken: !!ContextProxy.instance.getProviderSettings().kilocodeToken,
	}

	// Internal state
	let isBackspaceOperation = false // Flag to track backspace operations
	let justAcceptedSuggestion = false // Flag to track if a suggestion was just accepted
	let abortController: AbortController = new AbortController() // Track the current abort controller

	const completionsCache = new AutocompleteCache({
		maxSize: 50,
		ttlMs: 1000 * 60 * 60 * 24, // Cache for 24 hours
	})

	// Services
	const contextGatherer = new ContextGatherer()
	const animationManager = new AutocompleteDecorationAnimation()
	const statusBar = new AutocompleteStatusBar()

	// API Handling
	let apiHandler: ApiHandler | null = null
	const kilocodeToken = ContextProxy.instance.getProviderSettings().kilocodeToken
	if (kilocodeToken) {
		apiHandler = buildApiHandler({
			apiProvider: "kilocode",
			kilocodeToken,
			kilocodeModel: DEFAULT_MODEL,
		})
	}

	// Helper Functions
	const updateTokenStatus = () => {
		state.hasValidToken = !!ContextProxy.instance.getProviderSettings().kilocodeToken
	}

	const clearState = () => {
		vscode.commands.executeCommand("editor.action.inlineSuggest.hide")
		animationManager.stopAnimation()
		abortController?.abort() // Abort any ongoing requests

		isBackspaceOperation = false
		justAcceptedSuggestion = false
	}

	const generateCompletion = async ({
		codeContext,
		document,
		position,
	}: {
		codeContext: CodeContext
		document: vscode.TextDocument
		position: vscode.Position
	}) => {
		if (!apiHandler) throw new Error("apiHandler must be set before calling generateCompletion!")

		abortController?.abort() // Abort any previous request
		abortController = new AbortController()
		animationManager.startAnimation()

		const snippets = [
			...generateImportSnippets(true, codeContext.imports, document.uri.fsPath),
			...generateDefinitionSnippets(true, codeContext.definitions),
		]
		const systemPrompt = holeFillerTemplate.getSystemPrompt()
		const userPrompt = holeFillerTemplate.template(codeContext, document, position, snippets)

		console.log(`🚀🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶\n`, { userPrompt })

		const stream = apiHandler.createMessage(systemPrompt, [
			{ role: "user", content: [{ type: "text", text: userPrompt }] },
		])

		let completion = ""
		let processedCompletion = ""
		let lineCount = 0
		let completionCost = 0

		try {
			for await (const chunk of stream) {
				if (abortController.signal.aborted) {
					break // This request is no longer active
				}

				if (chunk.type === "text") {
					completion += chunk.text
					processedCompletion = processModelResponse(completion)
					lineCount += processedCompletion.split("/n").length
				} else if (chunk.type === "usage") {
					completionCost = chunk.totalCost ?? 0
				}

				if (lineCount > BAIL_OUT_TOO_MANY_LINES_LIMIT) {
					processedCompletion = ""
					break
				}
			}
		} catch (error) {
			// Don't log abort errors as they are expected when cancelling
			if (error.name !== "AbortError") {
				console.error("Error streaming completion:", error)
			}
			processedCompletion = ""
		}

		// Update cost tracking variables
		state.totalSessionCost += completionCost
		state.lastCompletionCost = completionCost
		console.log(`🚀💰 Completion cost: ${formatCost(completionCost)}`)

		// Update status bar with cost information
		statusBar.updateDisplay(state)

		// Stop animation when completion is done
		animationManager.stopAnimation()

		return { processedCompletion, lineCount, cost: completionCost }
	}

	const debouncedGenerateCompletion = createDebouncedFn(generateCompletion, UI_UPDATE_DEBOUNCE_MS)

	const provider: vscode.InlineCompletionItemProvider = {
		async provideInlineCompletionItems(document, position, context, token) {
			if (!state.enabled || !vscode.window.activeTextEditor) return null

			const kilocodeToken = ContextProxy.instance.getProviderSettings().kilocodeToken
			if (!kilocodeToken) {
				updateTokenStatus()
				statusBar.updateDisplay(state)
				return null
			}

			// Update token status and status bar if token is now available
			updateTokenStatus()
			statusBar.updateDisplay(state)

			// Create or recreate the API handler if needed
			apiHandler =
				apiHandler ??
				buildApiHandler({ apiProvider: "kilocode", kilocodeToken: kilocodeToken, kilocodeModel: DEFAULT_MODEL })

			// Skip providing completions if this was triggered by a backspace operation of if we just accepted a suggestion
			if (isBackspaceOperation || justAcceptedSuggestion) {
				return null
			}

			const codeContext = await contextGatherer.gatherContext(document, position, true, true)
			console.log(`🚀🛑 Autocomplete for line: '${codeContext.currentLine}'!`)

			// Check if we have a cached completion for this context
			const matchingCompletion = completionsCache.findMatchingCompletion(codeContext, document, position)
			if (matchingCompletion) {
				console.log(`🚀🎯 Using cached completion '${matchingCompletion.processedText}'`)
				animationManager.stopAnimation()
				return [createInlineCompletionItem(matchingCompletion.processedText, matchingCompletion.insertRange)]
			}

			const generationResult = await debouncedGenerateCompletion({ document, codeContext, position })
			if (!generationResult || token.isCancellationRequested) {
				return null
			}
			const { processedCompletion, cost } = generationResult
			console.log(`🚀🛑🚀🛑🚀🛑🚀🛑🚀🛑 \n`, {
				processedCompletion,
				cost: formatCost(cost || 0),
			})

			// Cache the successful completion for future use
			if (processedCompletion) {
				const wasAdded = completionsCache.addCompletion(codeContext, document, position, processedCompletion)
				if (wasAdded) {
					console.log(`🚀🛑 Saved new cache entry for completion: '${processedCompletion}'`)
				}
			}

			const processedResult = processTextInsertion({ document, position, textToInsert: processedCompletion })
			if (processedResult) {
				return [createInlineCompletionItem(processedResult.processedText, processedResult.insertRange)]
			}
			return null
		},
	}

	// Register provider and commands
	const providerDisposable = vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider)

	// Command to toggle autocomplete
	const toggleAutocompleteCommand = vscode.commands.registerCommand("kilo-code.toggleAutocomplete", () => {
		state.enabled = !state.enabled
		statusBar.updateDisplay(state)
		vscode.window.showInformationMessage(`Kilo Complete ${state.enabled ? "enabled" : "disabled"}`)
	})

	// Command to track when a suggestion is accepted
	const trackAcceptedSuggestionCommand = vscode.commands.registerCommand("kilo-code.trackAcceptedSuggestion", () => {
		justAcceptedSuggestion = true
	})

	// Event handlers
	const selectionHandler = vscode.window.onDidChangeTextEditorSelection((_e) => {
		// Reset the flag when selection changes
		// This ensures we only skip one completion request after accepting a suggestion
		justAcceptedSuggestion = false
	})
	const documentHandler = vscode.workspace.onDidChangeTextDocument((e) => {
		const editor = vscode.window.activeTextEditor
		if (!editor || editor.document !== e.document || !e.contentChanges.length) return

		clearState()

		// Check if this edit is from human typing rather than AI tools, copy-paste, etc.
		// Only trigger autocomplete for human edits to avoid interference
		const isHumanTyping = isHumanEdit(e)
		if (!isHumanTyping) {
			console.log("🚀🤖 Skipping autocomplete trigger during non-human edit")
			return
		}

		// Reset the justAcceptedSuggestion flag when the user makes any edit
		// This ensures we only skip one completion request after accepting a suggestion
		justAcceptedSuggestion = false

		// Detect backspace operations by checking content changes
		const change = e.contentChanges[0]
		if (change.rangeLength > 0 && change.text === "") {
			isBackspaceOperation = true
		}

		// Force inlineSuggestions to appear, even for whitespace changes
		// without this, hitting keys like spacebar won't show the completion
		vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
	})

	// Create a composite disposable to return
	const disposable = new vscode.Disposable(() => {
		providerDisposable.dispose()
		toggleAutocompleteCommand.dispose()
		trackAcceptedSuggestionCommand.dispose()
		statusBar.dispose()
		selectionHandler.dispose()
		documentHandler.dispose()
		animationManager.dispose()
	})

	// Still register with context for safety
	context.subscriptions.push(disposable)

	// Initialize status bar with correct state
	statusBar.updateDisplay(state)

	return disposable
}

/**
 * Creates an inline completion item with tracking command
 * @param completionText The text to be inserted as completion
 * @returns A configured vscode.InlineCompletionItem
 */
function createInlineCompletionItem(completionText: string, insertRange: vscode.Range): vscode.InlineCompletionItem {
	return Object.assign(new vscode.InlineCompletionItem(completionText, insertRange), {
		command: {
			command: "kilo-code.trackAcceptedSuggestion",
			title: "Track Accepted Suggestion",
			arguments: [completionText],
		},
	})
}
