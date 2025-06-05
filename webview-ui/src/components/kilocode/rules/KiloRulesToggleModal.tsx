import { useRef, useState, useEffect } from "react"
import { useWindowSize, useClickAway } from "react-use"
import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useTranslation } from "react-i18next"
import styled from "styled-components"

import Tooltip from "../../common/Tooltip"
import { vscode } from "@/utils/vscode"

import RulesToggleList from "./RulesToggleList"

const sortedRules = (data: Record<string, unknown> | undefined) =>
	Object.entries(data || {})
		.map(([path, enabled]): [string, boolean] => [path, enabled as boolean])
		.sort(([a], [b]) => a.localeCompare(b))

const KiloRulesToggleModal: React.FC = () => {
	const { t } = useTranslation()

	const [isVisible, setIsVisible] = useState(false)
	const buttonRef = useRef<HTMLDivElement>(null)
	const modalRef = useRef<HTMLDivElement>(null)
	const { width: viewportWidth, height: viewportHeight } = useWindowSize()
	const [arrowPosition, setArrowPosition] = useState(0)
	const [menuPosition, setMenuPosition] = useState(0)
	const [currentView, setCurrentView] = useState<"rules" | "workflows">("rules")
	const [localRules, setLocalRules] = useState<[string, boolean][]>([])
	const [globalRules, setGlobalRules] = useState<[string, boolean][]>([])
	const [localWorkflows, setLocalWorkflows] = useState<[string, boolean][]>([])
	const [globalWorkflows, setGlobalWorkflows] = useState<[string, boolean][]>([])

	useEffect(() => {
		if (isVisible) {
			vscode.postMessage({ type: "refreshRules" })
		}
	}, [isVisible])

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "rulesData") {
				setLocalRules(sortedRules(message.localRules))
				setGlobalRules(sortedRules(message.globalRules))
				setLocalWorkflows(sortedRules(message.localWorkflows))
				setGlobalWorkflows(sortedRules(message.globalWorkflows))
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	const toggleRule = (isGlobal: boolean, rulePath: string, enabled: boolean) => {
		vscode.postMessage({
			type: "toggleRule",
			rulePath,
			enabled,
			isGlobal,
		})
	}

	const toggleWorkflow = (isGlobal: boolean, workflowPath: string, enabled: boolean) => {
		vscode.postMessage({
			type: "toggleWorkflow",
			workflowPath,
			enabled,
			isGlobal,
		})
	}

	useClickAway(modalRef, () => {
		setIsVisible(false)
	})

	useEffect(() => {
		if (isVisible && buttonRef.current) {
			const buttonRect = buttonRef.current.getBoundingClientRect()
			const buttonCenter = buttonRect.left + buttonRect.width / 2
			const rightPosition = document.documentElement.clientWidth - buttonCenter - 5

			setArrowPosition(rightPosition)
			setMenuPosition(buttonRect.top + 1)
		}
	}, [isVisible, viewportWidth, viewportHeight])

	return (
		<div ref={modalRef}>
			<div ref={buttonRef} className="inline-flex min-w-0 max-w-full">
				<Tooltip tipText={t("kilocode:rules.tooltip")} visible={isVisible ? false : undefined}>
					<VSCodeButton
						appearance="icon"
						aria-label={t("kilocode:rules.ariaLabel")}
						onClick={() => setIsVisible(!isVisible)}
						style={{ padding: "0px 0px", height: "20px" }}>
						<div className="flex items-center gap-1 text-xs whitespace-nowrap min-w-0 w-full">
							<span
								className="codicon codicon-law flex items-center"
								style={{ fontSize: "12.5px", marginBottom: 1 }}
							/>
						</div>
					</VSCodeButton>
				</Tooltip>
			</div>

			{isVisible && (
				<div
					className="fixed left-[15px] right-[15px] border border-[var(--vscode-editorGroup-border)] p-3 rounded z-[1000] overflow-y-auto"
					style={{
						bottom: `calc(100vh - ${menuPosition}px + 6px)`,
						background: "var(--vscode-editor-background)",
						maxHeight: "calc(100vh - 100px)",
						overscrollBehavior: "contain",
					}}>
					<div
						className="fixed w-[10px] h-[10px] z-[-1] rotate-45 border-r border-b border-[var(--vscode-editorGroup-border)]"
						style={{
							bottom: `calc(100vh - ${menuPosition}px)`,
							right: arrowPosition,
							background: "var(--vscode-editor-background)",
						}}
					/>

					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							marginBottom: "10px",
						}}>
						<div
							style={{
								display: "flex",
								gap: "1px",
								borderBottom: "1px solid var(--vscode-panel-border)",
							}}>
							<StyledTabButton isActive={currentView === "rules"} onClick={() => setCurrentView("rules")}>
								{t("kilocode:rules.tabs.rules")}
							</StyledTabButton>
							<StyledTabButton
								isActive={currentView === "workflows"}
								onClick={() => setCurrentView("workflows")}>
								{t("kilocode:rules.tabs.workflows")}
							</StyledTabButton>
						</div>
					</div>

					<div className="text-xs text-[var(--vscode-descriptionForeground)] mb-4">
						{currentView === "rules" ? (
							<p>
								{t("kilocode:rules.description.rules")}{" "}
								<VSCodeLink
									href="https://kilocode.ai/docs/advanced-usage/rules"
									style={{ display: "inline" }}
									className="text-xs">
									{t("kilocode:docs")}
								</VSCodeLink>
							</p>
						) : (
							<p>
								{t("kilocode:rules.description.workflows")}{" "}
								<span className="text-[var(--vscode-foreground)] font-bold">/workflow-name</span>{" "}
								{t("kilocode:rules.description.workflowsInChat")}{" "}
								<VSCodeLink
									href="https://kilocode.ai/docs/advanced-usage/workflows"
									style={{ display: "inline" }}
									className="text-xs">
									{t("kilocode:docs")}
								</VSCodeLink>
							</p>
						)}
					</div>

					{currentView === "rules" ? (
						<>
							<div className="mb-3">
								<div className="text-sm font-normal mb-2">
									{t("kilocode:rules.sections.globalRules")}
								</div>
								<RulesToggleList
									rules={globalRules}
									toggleRule={(rulePath: string, enabled: boolean) =>
										toggleRule(true, rulePath, enabled)
									}
									listGap="small"
									isGlobal={true}
									ruleType="rule"
									showNewRule={true}
									showNoRules={false}
								/>
							</div>

							<div style={{ marginBottom: -10 }}>
								<div className="text-sm font-normal mb-2">
									{t("kilocode:rules.sections.workspaceRules")}
								</div>
								<RulesToggleList
									rules={localRules}
									toggleRule={(rulePath: string, enabled: boolean) =>
										toggleRule(false, rulePath, enabled)
									}
									listGap="small"
									isGlobal={false}
									ruleType="rule"
									showNewRule={true}
									showNoRules={false}
								/>
							</div>
						</>
					) : (
						<>
							<div className="mb-3">
								<div className="text-sm font-normal mb-2">
									{t("kilocode:rules.sections.globalWorkflows")}
								</div>
								<RulesToggleList
									rules={globalWorkflows}
									toggleRule={(rulePath: string, enabled: boolean) =>
										toggleWorkflow(true, rulePath, enabled)
									}
									listGap="small"
									isGlobal={true}
									ruleType="workflow"
									showNewRule={true}
									showNoRules={false}
								/>
							</div>

							<div style={{ marginBottom: -10 }}>
								<div className="text-sm font-normal mb-2">
									{t("kilocode:rules.sections.workspaceWorkflows")}
								</div>
								<RulesToggleList
									rules={localWorkflows}
									toggleRule={(rulePath: string, enabled: boolean) =>
										toggleWorkflow(false, rulePath, enabled)
									}
									listGap="small"
									isGlobal={false}
									ruleType="workflow"
									showNewRule={true}
									showNoRules={false}
								/>
							</div>
						</>
					)}
				</div>
			)}
		</div>
	)
}

const StyledTabButton = styled.button<{ isActive: boolean }>`
	background: none;
	border: none;
	border-bottom: 2px solid ${(props) => (props.isActive ? "var(--vscode-foreground)" : "transparent")};
	color: ${(props) => (props.isActive ? "var(--vscode-foreground)" : "var(--vscode-descriptionForeground)")};
	padding: 8px 16px;
	cursor: pointer;
	font-size: 13px;
	margin-bottom: -1px;
	font-family: inherit;

	&:hover {
		color: var(--vscode-foreground);
	}
`

export default KiloRulesToggleModal
