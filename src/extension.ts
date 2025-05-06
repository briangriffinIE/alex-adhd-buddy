import * as vscode from 'vscode';

type TaskStatus = 'dev' | 'code_review' | 'to_deploy' | 'deployed';
type TaskEnvironment = 'dev' | 'centest' | 'uat' | 'weekc' | 'production';

interface Task {
    jiraId: string;
    notes: string;
    modifiedFiles: string[];
    createdAt: Date;
    status: TaskStatus;
    environment: TaskEnvironment;
}

interface AlexSettings {
    taskStatuses: TaskStatus[];
    environments: TaskEnvironment[];
    pomodoro: {
        workDuration: number;
        shortBreakDuration: number;
        longBreakDuration: number;
        longBreakInterval: number;
    };
    focusMode: {
        hideSidebar: boolean;
        hideActivityBar: boolean;
        hideStatusBar: boolean;
        hidePanel: boolean;
        hideMinimap: boolean;
        hideLineNumbers: boolean;
    };
    notifications: {
        enableInactivityAlerts: boolean;
        inactivityThreshold: number;
        enablePomodoroNotifications: boolean;
        enableTaskReminders: boolean;
    };
}

class AlexProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'alexView';
    private _view?: vscode.WebviewView;
    private _tasks: Task[] = [];
    private _pomodoroTimer?: NodeJS.Timeout;
    private _inactivityTimer?: NodeJS.Timeout;
    private _lastActivityTime: number = Date.now();
    private _isFocusMode: boolean = false;
    private _settings: AlexSettings;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        // Load saved tasks
        const savedTasks = this._context.globalState.get<Task[]>('alex.tasks') || [];
        this._tasks = savedTasks.map(task => ({
            ...task,
            createdAt: new Date(task.createdAt)
        }));
        
        // Load or initialize settings
        this._settings = this._loadSettings();
        
        // Set up inactivity monitoring
        this._setupInactivityMonitoring();
    }

    private _loadSettings(): AlexSettings {
        const config = vscode.workspace.getConfiguration('alex');
        
        return {
            taskStatuses: config.get<TaskStatus[]>('taskStatuses') || ['dev', 'code_review', 'to_deploy', 'deployed'],
            environments: config.get<TaskEnvironment[]>('environments') || ['dev', 'centest', 'uat', 'weekc', 'production'],
            pomodoro: {
                workDuration: config.get<number>('pomodoro.workDuration') || 25,
                shortBreakDuration: config.get<number>('pomodoro.shortBreakDuration') || 5,
                longBreakDuration: config.get<number>('pomodoro.longBreakDuration') || 15,
                longBreakInterval: config.get<number>('pomodoro.longBreakInterval') || 4
            },
            focusMode: {
                hideSidebar: config.get<boolean>('focusMode.hideSidebar') ?? true,
                hideActivityBar: config.get<boolean>('focusMode.hideActivityBar') ?? true,
                hideStatusBar: config.get<boolean>('focusMode.hideStatusBar') ?? true,
                hidePanel: config.get<boolean>('focusMode.hidePanel') ?? true,
                hideMinimap: config.get<boolean>('focusMode.hideMinimap') ?? true,
                hideLineNumbers: config.get<boolean>('focusMode.hideLineNumbers') ?? true
            },
            notifications: {
                enableInactivityAlerts: config.get<boolean>('notifications.enableInactivityAlerts') ?? true,
                inactivityThreshold: config.get<number>('notifications.inactivityThreshold') || 5,
                enablePomodoroNotifications: config.get<boolean>('notifications.enablePomodoroNotifications') ?? true,
                enableTaskReminders: config.get<boolean>('notifications.enableTaskReminders') ?? true
            }
        };
    }

    private async _saveSettings(settings: Partial<AlexSettings>) {
        const config = vscode.workspace.getConfiguration('alex');
        
        // Update settings
        this._settings = { ...this._settings, ...settings };
        
        // Save to VS Code settings
        await config.update('taskStatuses', this._settings.taskStatuses, true);
        await config.update('environments', this._settings.environments, true);
        await config.update('pomodoro', this._settings.pomodoro, true);
        await config.update('focusMode', this._settings.focusMode, true);
        await config.update('notifications', this._settings.notifications, true);
        
        // If Pomodoro settings were updated and timer is running, restart it
        if (settings.pomodoro && this._pomodoroTimer) {
            this._startPomodoro();
        }
        
        // Update webview
        this._updateWebview();
    }

    private _setupInactivityMonitoring() {
        // Monitor editor activity
        vscode.window.onDidChangeActiveTextEditor(() => {
            this._lastActivityTime = Date.now();
        });

        // Check for inactivity every minute
        setInterval(() => {
            const inactiveMinutes = (Date.now() - this._lastActivityTime) / (1000 * 60);
            const threshold = vscode.workspace.getConfiguration('alex').get<number>('inactivityThreshold') || 5;
            
            if (inactiveMinutes >= threshold) {
                vscode.window.showInformationMessage('Alex: You\'ve been inactive for a while. Need a gentle reminder to focus?');
            }
        }, 60000);
    }

    private async _addTask(jiraId: string, notes: string, status: TaskStatus, environment: TaskEnvironment, selectedFiles: string[]) {
        const task: Task = {
            jiraId,
            notes,
            modifiedFiles: selectedFiles,
            createdAt: new Date(),
            status,
            environment
        };

        this._tasks.push(task);
        await this._context.globalState.update('alex.tasks', this._tasks);
        
        // Log the current state
        console.log('Tasks after adding:', this._tasks);
        
        // Ensure we update the webview after adding the task
        this._updateWebview();
        
        // Show confirmation message
        vscode.window.showInformationMessage(`Task ${jiraId} added successfully!`);
    }

    private _startPomodoro() {
        const duration = this._settings.pomodoro.workDuration;
        
        if (this._pomodoroTimer) {
            clearTimeout(this._pomodoroTimer);
        }

        const endTime = Date.now() + (duration * 60 * 1000);
        
        this._pomodoroTimer = setInterval(() => {
            const remaining = Math.max(0, endTime - Date.now());
            if (remaining === 0) {
                vscode.window.showInformationMessage('Pomodoro session complete! Time for a break.');
                clearInterval(this._pomodoroTimer);
                this._pomodoroTimer = undefined;
                if (this._view) {
                    this._view.webview.postMessage({
                        type: 'updateTimer',
                        time: '00:00'
                    });
                }
            } else {
                const minutes = Math.floor(remaining / (60 * 1000));
                const seconds = Math.floor((remaining % (60 * 1000)) / 1000);
                if (this._view) {
                    this._view.webview.postMessage({
                        type: 'updateTimer',
                        time: `${minutes}:${seconds.toString().padStart(2, '0')}`
                    });
                }
            }
        }, 1000);

        // Initial timer update
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateTimer',
                time: `${duration}:00`
            });
        }
    }

    private _toggleFocusMode() {
        this._isFocusMode = !this._isFocusMode;
        
        // Apply focus mode settings
        if (this._settings.focusMode.hideSidebar) {
            vscode.workspace.getConfiguration('workbench').update('sideBar.visible', !this._isFocusMode, true);
        }
        if (this._settings.focusMode.hideMinimap) {
            vscode.workspace.getConfiguration('editor').update('minimap.enabled', !this._isFocusMode, true);
        }
        if (this._settings.focusMode.hideLineNumbers) {
            vscode.workspace.getConfiguration('editor').update('lineNumbers', this._isFocusMode ? 'off' : 'on', true);
        }
        if (this._settings.focusMode.hideActivityBar) {
            vscode.workspace.getConfiguration('workbench').update('activityBar.visible', !this._isFocusMode, true);
        }
        if (this._settings.focusMode.hideStatusBar) {
            vscode.workspace.getConfiguration('workbench').update('statusBar.visible', !this._isFocusMode, true);
        }
        if (this._settings.focusMode.hidePanel) {
            vscode.workspace.getConfiguration('workbench').update('panel.visible', !this._isFocusMode, true);
        }
        
        // Update the webview
        if (this._view) {
            this._view.webview.postMessage({
                type: 'focusModeChanged',
                isEnabled: this._isFocusMode
            });
        }

        vscode.window.showInformationMessage(
            this._isFocusMode 
                ? 'Focus Mode Enabled: Distractions minimized for better concentration' 
                : 'Focus Mode Disabled: All UI elements restored'
        );
    }

    private _updateWebview() {
        if (this._view) {
            try {
                // Convert dates to strings for proper serialization
                const serializedTasks = this._tasks.map(task => ({
                    ...task,
                    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : new Date(task.createdAt).toISOString()
                }));

                console.log('Sending tasks to webview:', serializedTasks);

                this._view.webview.postMessage({
                    type: 'updateTasks',
                    tasks: serializedTasks
                });
            } catch (error) {
                vscode.window.showErrorMessage(`Error updating webview: ${error}`);
            }
        }
    }

    private async _deleteTask(index: number) {
        this._tasks.splice(index, 1);
        await this._context.globalState.update('alex.tasks', this._tasks);
        this._updateWebview();
        vscode.window.showInformationMessage('Task deleted successfully!');
    }

    private async _updateTask(index: number, updates: Partial<Task>) {
        this._tasks[index] = { ...this._tasks[index], ...updates };
        await this._context.globalState.update('alex.tasks', this._tasks);
        this._updateWebview();
        vscode.window.showInformationMessage('Task updated successfully!');
    }

    private async _getProjectFiles(): Promise<string[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return [];
        }

        const files: string[] = [];
        for (const folder of workspaceFolders) {
            const pattern = new vscode.RelativePattern(folder, '**/*');
            const fileUris = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
            files.push(...fileUris.map(uri => {
                const relativePath = vscode.workspace.asRelativePath(uri);
                return relativePath;
            }));
        }
        return files.sort();
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const style = `
            body {
                padding: 20px;
                font-family: var(--vscode-font-family);
                color: var(--vscode-foreground);
                max-width: 800px;
                margin: 0 auto;
                line-height: 1.5;
            }

            .section {
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 8px;
                padding: 20px;
                margin-bottom: 24px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
                transition: transform 0.2s ease, box-shadow 0.2s ease;
            }

            .section:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            }

            .section-title {
                font-size: 1.3em;
                font-weight: 600;
                margin-bottom: 16px;
                color: var(--vscode-foreground);
                display: flex;
                align-items: center;
                gap: 8px;
                padding-bottom: 12px;
                border-bottom: 2px solid var(--vscode-panel-border);
            }

            .timer {
                font-size: 48px;
                text-align: center;
                margin: 24px 0;
                font-weight: 700;
                color: var(--vscode-foreground);
                text-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                font-family: 'SF Mono', 'Consolas', monospace;
            }

            .controls {
                display: flex;
                gap: 12px;
                margin-bottom: 20px;
                flex-wrap: wrap;
            }

            button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 10px 20px;
                cursor: pointer;
                border-radius: 6px;
                font-size: 14px;
                font-weight: 500;
                display: flex;
                align-items: center;
                gap: 8px;
                transition: all 0.2s ease;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            }

            button:hover {
                background: var(--vscode-button-hoverBackground);
                transform: translateY(-1px);
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
            }

            button:active {
                transform: translateY(0);
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            }

            .task-form {
                display: flex;
                flex-direction: column;
                gap: 16px;
                width: 100%;
            }

            .form-group {
                display: flex;
                flex-direction: column;
                gap: 6px;
                width: 100%;
            }

            .form-group label {
                font-size: 13px;
                font-weight: 500;
                color: var(--vscode-foreground);
                margin-bottom: 4px;
            }

            input, textarea, select {
                width: 100%;
                padding: 10px 14px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                border-radius: 6px;
                font-size: 14px;
                box-sizing: border-box;
                transition: all 0.2s ease;
            }

            input:focus, textarea:focus, select:focus {
                outline: none;
                border-color: var(--vscode-focusBorder);
                box-shadow: 0 0 0 2px rgba(var(--vscode-focusBorder-rgb), 0.2);
            }

            textarea {
                min-height: 100px;
                resize: vertical;
                line-height: 1.5;
            }

            .task-list {
                display: flex;
                flex-direction: column;
                gap: 16px;
            }

            .task-item {
                background: var(--vscode-editor-background);
                padding: 20px;
                border: 1px solid var(--vscode-panel-border);
                border-radius: 8px;
                transition: all 0.2s ease;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
            }

            .task-item:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            }

            .task-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 12px;
            }

            .task-id {
                font-weight: 600;
                font-size: 1.1em;
                color: var(--vscode-foreground);
            }

            .task-time {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                background: var(--vscode-badge-background);
                padding: 4px 8px;
                border-radius: 4px;
            }

            .task-notes {
                color: var(--vscode-foreground);
                margin: 12px 0;
                line-height: 1.6;
                font-size: 14px;
            }

            .task-meta {
                display: flex;
                align-items: center;
                gap: 12px;
                margin-top: 12px;
                flex-wrap: wrap;
            }

            .status-badge, .environment-badge {
                display: inline-flex;
                align-items: center;
                padding: 6px 12px;
                border-radius: 16px;
                font-size: 12px;
                font-weight: 500;
                letter-spacing: 0.3px;
            }

            .status-dev { background: #4DABF7; color: white; }
            .status-code_review { background: #FFD43B; color: black; }
            .status-to_deploy { background: #FF922B; color: white; }
            .status-deployed { background: #51CF66; color: white; }

            .env-dev { background: #4DABF7; color: white; }
            .env-centest { background: #FF922B; color: white; }
            .env-uat { background: #FF6B6B; color: white; }
            .env-weekc { background: #845EF7; color: white; }
            .env-production { background: #51CF66; color: white; }

            .task-actions {
                display: flex;
                gap: 8px;
                margin-top: 16px;
                padding-top: 16px;
                border-top: 1px solid var(--vscode-panel-border);
            }

            .action-button {
                padding: 6px 12px;
                font-size: 12px;
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: none;
                border-radius: 4px;
                cursor: pointer;
                transition: all 0.2s ease;
            }

            .action-button:hover {
                background: var(--vscode-button-secondaryHoverBackground);
                transform: translateY(-1px);
            }

            .action-button.delete {
                background: var(--vscode-errorForeground);
                color: white;
            }

            .action-button.delete:hover {
                background: var(--vscode-errorForeground);
                opacity: 0.9;
            }

            .file-selection {
                max-height: 400px;
                overflow-y: auto;
                border: 1px solid var(--vscode-panel-border);
                border-radius: 6px;
                margin-top: 8px;
                background: var(--vscode-editor-background);
                box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.05);
            }

            .file-search-container {
                position: sticky;
                top: 0;
                background: var(--vscode-editor-background);
                padding: 16px;
                border-bottom: 1px solid var(--vscode-panel-border);
                z-index: 1;
            }

            .file-search-input {
                width: 100%;
                padding: 10px 14px;
                border: 1px solid var(--vscode-input-border);
                border-radius: 6px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                font-size: 14px;
                transition: all 0.2s ease;
            }

            .file-search-input:focus {
                outline: none;
                border-color: var(--vscode-focusBorder);
                box-shadow: 0 0 0 2px rgba(var(--vscode-focusBorder-rgb), 0.2);
            }

            .file-group {
                margin-bottom: 16px;
                border: 1px solid var(--vscode-panel-border);
                border-radius: 6px;
                overflow: hidden;
                background: var(--vscode-editor-background);
            }

            .file-group-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                background: var(--vscode-editor-lineHighlightBackground);
                border-bottom: 1px solid var(--vscode-panel-border);
            }

            .file-group-title {
                font-weight: 600;
                font-size: 13px;
                color: var(--vscode-foreground);
            }

            .file-group-count {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                background: var(--vscode-badge-background);
                padding: 2px 8px;
                border-radius: 12px;
            }

            .file-group-content {
                padding: 8px;
            }

            .file-select-item {
                display: flex;
                align-items: center;
                padding: 8px 12px;
                border-radius: 4px;
                transition: background-color 0.2s ease;
                margin: 2px 0;
            }

            .file-select-item:hover {
                background: var(--vscode-list-hoverBackground);
            }

            .file-select-item input[type="checkbox"] {
                margin: 0;
                margin-right: 12px;
                width: 16px;
                height: 16px;
            }

            .file-select-item label {
                display: flex;
                align-items: center;
                font-size: 13px;
                color: var(--vscode-foreground);
                cursor: pointer;
                flex: 1;
            }

            .file-name {
                color: var(--vscode-foreground);
                font-size: 13px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .no-results {
                padding: 24px;
                text-align: center;
                color: var(--vscode-descriptionForeground);
                font-style: italic;
                background: var(--vscode-editor-background);
                border-radius: 6px;
                margin: 16px;
            }

            .filter-controls {
                display: flex;
                gap: 16px;
                margin-bottom: 20px;
                flex-wrap: wrap;
                padding: 16px;
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 6px;
            }

            .filter-group {
                display: flex;
                align-items: center;
                gap: 8px;
                flex: 1;
                min-width: 200px;
            }

            .filter-group label {
                font-size: 13px;
                font-weight: 500;
                color: var(--vscode-foreground);
                white-space: nowrap;
            }

            .filter-group select {
                flex: 1;
                min-width: 150px;
            }

            .settings-section {
                margin-top: 24px;
                padding: 20px;
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 8px;
            }

            .settings-group {
                margin-bottom: 24px;
                padding-bottom: 24px;
                border-bottom: 1px solid var(--vscode-panel-border);
            }

            .settings-group:last-child {
                margin-bottom: 0;
                padding-bottom: 0;
                border-bottom: none;
            }

            .settings-group-title {
                font-weight: 600;
                font-size: 1.1em;
                margin-bottom: 16px;
                color: var(--vscode-foreground);
            }

            .settings-row {
                display: flex;
                align-items: center;
                gap: 12px;
                margin-bottom: 12px;
            }

            .settings-input {
                flex: 1;
            }

            .settings-actions {
                display: flex;
                gap: 12px;
                margin-top: 16px;
            }

            .settings-button {
                padding: 8px 16px;
                font-size: 13px;
            }

            .focus-mode-indicator {
                display: none;
                position: fixed;
                top: 16px;
                right: 16px;
                background: var(--vscode-errorForeground);
                color: white;
                padding: 8px 16px;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 500;
                z-index: 1000;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                animation: slideIn 0.3s ease;
            }

            @keyframes slideIn {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }

            .focus-mode-indicator.active {
                display: block;
            }
        `;

        const script = `
            const vscode = acquireVsCodeApi();
            let currentTasks = [];
            let currentFilters = {
                status: 'all',
                environment: 'all'
            };
            let projectFiles = [];
            
            function addTask() {
                const jiraId = document.getElementById('jiraId').value;
                const notes = document.getElementById('notes').value;
                const status = document.getElementById('status').value;
                const environment = document.getElementById('environment').value;
                const selectedFiles = Array.from(document.querySelectorAll('input[name="fileSelect"]:checked')).map(cb => cb.value);
                
                if (!jiraId) {
                    vscode.postMessage({
                        type: 'showError',
                        message: 'Please enter a JIRA ticket number'
                    });
                    return;
                }
                
                console.log('Sending addTask message:', { jiraId, notes, status, environment, selectedFiles });
                
                vscode.postMessage({
                    type: 'addTask',
                    jiraId,
                    notes,
                    status,
                    environment,
                    selectedFiles
                });
                
                // Clear form
                document.getElementById('jiraId').value = '';
                document.getElementById('notes').value = '';
                document.getElementById('status').value = 'dev';
                document.getElementById('environment').value = 'dev';
                document.querySelectorAll('input[name="fileSelect"]').forEach(cb => cb.checked = false);
            }
            
            function deleteTask(index) {
                vscode.postMessage({
                    type: 'deleteTask',
                    index: index
                });
            }
            
            function updateTask(index, updates) {
                vscode.postMessage({
                    type: 'updateTask',
                    index: index,
                    updates: updates
                });
            }
            
            function toggleEditForm(taskId) {
                const form = document.getElementById('edit-form-' + taskId);
                form.classList.toggle('active');
            }
            
            function applyFilters() {
                const statusFilter = document.getElementById('statusFilter').value;
                const envFilter = document.getElementById('envFilter').value;
                
                currentFilters = {
                    status: statusFilter,
                    environment: envFilter
                };
                
                updateTaskList(currentTasks);
            }
            
            function updateTaskList(tasks) {
                console.log('Updating task list with:', tasks);
                if (!Array.isArray(tasks)) {
                    console.error('Received invalid tasks data:', tasks);
                    return;
                }
                
                currentTasks = tasks;
                const taskList = document.getElementById('taskList');
                
                if (!tasks || tasks.length === 0) {
                    taskList.innerHTML = '<div class="empty-state">No tasks yet. Add your first task above!</div>';
                    return;
                }
                
                // Apply filters
                const filteredTasks = tasks.filter(task => {
                    if (currentFilters.status !== 'all' && task.status !== currentFilters.status) {
                        return false;
                    }
                    if (currentFilters.environment !== 'all' && task.environment !== currentFilters.environment) {
                        return false;
                    }
                    return true;
                });
                
                const taskHtml = filteredTasks.map((task, index) => {
                    if (!task) {
                        console.error('Invalid task object:', task);
                        return '';
                    }
                    
                    const status = task.status || 'dev';
                    const environment = task.environment || 'dev';
                    const createdAt = new Date(task.createdAt).toLocaleString();
                    const modifiedFilesCount = Array.isArray(task.modifiedFiles) ? task.modifiedFiles.length : 0;
                    
                    return \`
                        <div class="task-item">
                            <div class="task-header">
                                <span class="task-id">\${task.jiraId}</span>
                                <span class="task-time">\${createdAt}</span>
                            </div>
                            <div class="task-notes">\${task.notes || ''}</div>
                            <div class="task-meta">
                                <span class="status-badge status-\${status}">\${status.replace('_', ' ').replace(/\\b\\w/g, l => l.toUpperCase())}</span>
                                <span class="environment-badge env-\${environment}">\${environment.charAt(0).toUpperCase() + environment.slice(1)}</span>
                                <span class="task-files">Modified files: \${modifiedFilesCount}</span>
                            </div>
                            <div class="task-files-list">
                                \${Array.isArray(task.modifiedFiles) ? task.modifiedFiles.map(file => 
                                    \`<div class="file-item">\${file}</div>\`
                                ).join('') : ''}
                            </div>
                            <div class="task-actions">
                                <button class="action-button" onclick="toggleEditForm('\${task.jiraId}')">Edit</button>
                                <button class="action-button delete" onclick="deleteTask(\${index})">Delete</button>
                            </div>
                            <div id="edit-form-\${task.jiraId}" class="edit-form">
                                <div class="form-group">
                                    <label for="edit-status-\${task.jiraId}">Status</label>
                                    <select id="edit-status-\${task.jiraId}">
                                        <option value="dev" \${status === 'dev' ? 'selected' : ''}>Development</option>
                                        <option value="code_review" \${status === 'code_review' ? 'selected' : ''}>Code Review</option>
                                        <option value="to_deploy" \${status === 'to_deploy' ? 'selected' : ''}>To Deploy</option>
                                        <option value="deployed" \${status === 'deployed' ? 'selected' : ''}>Deployed</option>
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label for="edit-environment-\${task.jiraId}">Environment</label>
                                    <select id="edit-environment-\${task.jiraId}">
                                        <option value="dev" \${environment === 'dev' ? 'selected' : ''}>Development</option>
                                        <option value="centest" \${environment === 'centest' ? 'selected' : ''}>Centest</option>
                                        <option value="uat" \${environment === 'uat' ? 'selected' : ''}>UAT</option>
                                        <option value="weekc" \${environment === 'weekc' ? 'selected' : ''}>Weekc</option>
                                        <option value="production" \${environment === 'production' ? 'selected' : ''}>Production</option>
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label for="edit-notes-\${task.jiraId}">Notes</label>
                                    <textarea id="edit-notes-\${task.jiraId}">\${task.notes || ''}</textarea>
                                </div>
                                <div class="form-group">
                                    <label>Selected Files</label>
                                    <div class="file-selection">
                                        \${projectFiles.map(file => \`
                                            <div class="file-select-item">
                                                <input type="checkbox" 
                                                       id="edit-file-\${task.jiraId}-\${file}" 
                                                       name="edit-fileSelect-\${task.jiraId}" 
                                                       value="\${file}"
                                                       \${task.modifiedFiles.includes(file) ? 'checked' : ''}>
                                                <label for="edit-file-\${task.jiraId}-\${file}">\${file}</label>
                                            </div>
                                        \`).join('')}
                                    </div>
                                </div>
                                <button class="action-button" onclick="updateTask(\${index}, {
                                    status: document.getElementById('edit-status-\${task.jiraId}').value,
                                    environment: document.getElementById('edit-environment-\${task.jiraId}').value,
                                    notes: document.getElementById('edit-notes-\${task.jiraId}').value,
                                    modifiedFiles: Array.from(document.querySelectorAll('input[name=\\'edit-fileSelect-\${task.jiraId}\\']:checked')).map(cb => cb.value)
                                })">Save Changes</button>
                            </div>
                        </div>
                    \`;
                }).join('');
                
                taskList.innerHTML = taskHtml;
            }
            
            function startPomodoro() {
                vscode.postMessage({
                    type: 'startPomodoro'
                });
            }
            
            function toggleFocusMode() {
                vscode.postMessage({
                    type: 'toggleFocusMode'
                });
            }
            
            function openSettings() {
                const settingsSection = document.getElementById('settingsSection');
                settingsSection.style.display = settingsSection.style.display === 'none' ? 'block' : 'none';
            }

            function addNewStatus() {
                const statusInput = document.getElementById('newStatus');
                const status = statusInput.value.trim();
                if (status) {
                    vscode.postMessage({
                        type: 'addTaskStatus',
                        status: status
                    });
                    statusInput.value = '';
                }
            }

            function addNewEnvironment() {
                const envInput = document.getElementById('newEnvironment');
                const env = envInput.value.trim();
                if (env) {
                    vscode.postMessage({
                        type: 'addEnvironment',
                        environment: env
                    });
                    envInput.value = '';
                }
            }

            function updatePomodoroSettings() {
                const settings = {
                    workDuration: parseInt(document.getElementById('workDuration').value),
                    shortBreakDuration: parseInt(document.getElementById('shortBreakDuration').value),
                    longBreakDuration: parseInt(document.getElementById('longBreakDuration').value),
                    longBreakInterval: parseInt(document.getElementById('longBreakInterval').value)
                };
                
                vscode.postMessage({
                    type: 'updatePomodoroSettings',
                    settings: settings
                });

                // Update the timer display immediately
                const timerElement = document.getElementById('timer');
                if (timerElement) {
                    timerElement.textContent = settings.workDuration + ':00';
                }
            }

            function updateFocusModeSettings() {
                const settings = {
                    hideSidebar: document.getElementById('hideSidebar').checked,
                    hideActivityBar: document.getElementById('hideActivityBar').checked,
                    hideStatusBar: document.getElementById('hideStatusBar').checked,
                    hidePanel: document.getElementById('hidePanel').checked,
                    hideMinimap: document.getElementById('hideMinimap').checked,
                    hideLineNumbers: document.getElementById('hideLineNumbers').checked
                };
                
                vscode.postMessage({
                    type: 'updateFocusModeSettings',
                    settings: settings
                });
            }

            function updateNotificationSettings() {
                const settings = {
                    enableInactivityAlerts: document.getElementById('enableInactivityAlerts').checked,
                    inactivityThreshold: parseInt(document.getElementById('inactivityThreshold').value),
                    enablePomodoroNotifications: document.getElementById('enablePomodoroNotifications').checked,
                    enableTaskReminders: document.getElementById('enableTaskReminders').checked
                };
                
                vscode.postMessage({
                    type: 'updateNotificationSettings',
                    settings: settings
                });
            }

            function updateFileSelection() {
                const fileSelection = document.getElementById('fileSelection');
                if (fileSelection) {
                    const searchInput = document.getElementById('fileSearch');
                    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
                    
                    // Improved search: match against both filename and path
                    const filteredFiles = projectFiles.filter(file => {
                        const fileName = file.split('/').pop()?.toLowerCase() || '';
                        return fileName.includes(searchTerm) || file.toLowerCase().includes(searchTerm);
                    });

                    // Group files by directory
                    const groupedFiles = filteredFiles.reduce((groups, file) => {
                        const dir = file.split('/').slice(0, -1).join('/') || 'root';
                        if (!groups[dir]) {
                            groups[dir] = [];
                        }
                        groups[dir].push(file);
                        return groups;
                    }, {});

                    // Sort directories alphabetically
                    const sortedGroups = Object.entries(groupedFiles).sort(([dirA], [dirB]) => {
                        if (dirA === 'root') return -1;
                        if (dirB === 'root') return 1;
                        return dirA.localeCompare(dirB);
                    });

                    // Only update the file list, not the search container
                    const fileList = fileSelection.querySelector('.file-list');
                    if (fileList) {
                        fileList.innerHTML = \`
                            \${sortedGroups.length > 0 ? sortedGroups.map(([dir, files]) => \`
                                <div class="file-group">
                                    <div class="file-group-header">
                                        <span class="file-group-title">\${dir === 'root' ? 'Project Root' : dir}</span>
                                        <span class="file-group-count">\${files.length} files</span>
                                    </div>
                                    <div class="file-group-content">
                                        \${files.map(file => {
                                            const fileName = file.split('/').pop();
                                            return \`
                                                <div class="file-select-item">
                                                    <input type="checkbox" 
                                                           id="file-\${file}" 
                                                           name="fileSelect" 
                                                           value="\${file}">
                                                    <label for="file-\${file}" title="\${file}">
                                                        <span class="file-name">\${fileName}</span>
                                                    </label>
                                                </div>
                                            \`;
                                        }).join('')}
                                    </div>
                                </div>
                            \`).join('') : \`<div class="no-results">No files found matching "\${searchTerm}"</div>\`}
                        \`;
                    } else {
                        // Initial render of the entire component
                        fileSelection.innerHTML = \`
                            <div class="file-search-container">
                                <input type="text" 
                                       id="fileSearch" 
                                       placeholder="Search files by name or path..." 
                                       onkeyup="updateFileSelection()"
                                       class="file-search-input">
                            </div>
                            <div class="file-list">
                                \${sortedGroups.length > 0 ? sortedGroups.map(([dir, files]) => \`
                                    <div class="file-group">
                                        <div class="file-group-header">
                                            <span class="file-group-title">\${dir === 'root' ? 'Project Root' : dir}</span>
                                            <span class="file-group-count">\${files.length} files</span>
                                        </div>
                                        <div class="file-group-content">
                                            \${files.map(file => {
                                                const fileName = file.split('/').pop();
                                                return \`
                                                    <div class="file-select-item">
                                                        <input type="checkbox" 
                                                               id="file-\${file}" 
                                                               name="fileSelect" 
                                                               value="\${file}">
                                                        <label for="file-\${file}" title="\${file}">
                                                            <span class="file-name">\${fileName}</span>
                                                        </label>
                                                    </div>
                                                \`;
                                            }).join('')}
                                        </div>
                                    </div>
                                \`).join('') : \`<div class="no-results">No files found matching "\${searchTerm}"</div>\`}
                            </div>
                        \`;
                    }
                }
            }

            window.addEventListener('message', event => {
                const message = event.data;
                console.log('Received message:', message);
                
                switch (message.type) {
                    case 'updateTasks':
                        console.log('Received tasks update:', message.tasks);
                        if (Array.isArray(message.tasks)) {
                            updateTaskList(message.tasks);
                        } else {
                            console.error('Received invalid tasks data:', message.tasks);
                        }
                        break;
                    case 'updateTimer':
                        document.getElementById('timer').textContent = message.time;
                        break;
                    case 'focusModeChanged':
                        const indicator = document.getElementById('focusModeIndicator');
                        if (message.isEnabled) {
                            indicator.classList.add('active');
                            indicator.textContent = 'Focus Mode Active';
                        } else {
                            indicator.classList.remove('active');
                        }
                        break;
                    case 'updateSettings':
                        updateSettingsUI(message.settings);
                        break;
                    case 'updateProjectFiles':
                        projectFiles = message.files;
                        updateFileSelection();
                        break;
                }
            });

            function updateSettingsUI(settings) {
                // Update task statuses
                const statusSelects = document.querySelectorAll('select[id$="status"]');
                statusSelects.forEach(select => {
                    const currentValue = select.value;
                    select.innerHTML = settings.taskStatuses.map(status => 
                        \`<option value="\${status}" \${status === currentValue ? 'selected' : ''}>\${status.replace('_', ' ').replace(/\\b\\w/g, l => l.toUpperCase())}</option>\`);
                });

                // Update environments
                const envSelects = document.querySelectorAll('select[id$="environment"]');
                envSelects.forEach(select => {
                    const currentValue = select.value;
                    select.innerHTML = settings.environments.map(env => 
                        \`<option value="\${env}" \${env === currentValue ? 'selected' : ''}>\${env.charAt(0).toUpperCase() + env.slice(1)}</option>\`);
                });

                // Update Pomodoro settings
                document.getElementById('workDuration').value = settings.pomodoro.workDuration;
                document.getElementById('shortBreakDuration').value = settings.pomodoro.shortBreakDuration;
                document.getElementById('longBreakDuration').value = settings.pomodoro.longBreakDuration;
                document.getElementById('longBreakInterval').value = settings.pomodoro.longBreakInterval;

                // Update Focus Mode settings
                document.getElementById('hideSidebar').checked = settings.focusMode.hideSidebar;
                document.getElementById('hideActivityBar').checked = settings.focusMode.hideActivityBar;
                document.getElementById('hideStatusBar').checked = settings.focusMode.hideStatusBar;
                document.getElementById('hidePanel').checked = settings.focusMode.hidePanel;
                document.getElementById('hideMinimap').checked = settings.focusMode.hideMinimap;
                document.getElementById('hideLineNumbers').checked = settings.focusMode.hideLineNumbers;

                // Update Notification settings
                document.getElementById('enableInactivityAlerts').checked = settings.notifications.enableInactivityAlerts;
                document.getElementById('inactivityThreshold').value = settings.notifications.inactivityThreshold;
                document.getElementById('enablePomodoroNotifications').checked = settings.notifications.enablePomodoroNotifications;
                document.getElementById('enableTaskReminders').checked = settings.notifications.enableTaskReminders;
            }

            // Request initial tasks and project files when the webview loads
            console.log('Requesting initial tasks and project files');
            vscode.postMessage({ type: 'requestTasks' });
            vscode.postMessage({ type: 'requestProjectFiles' });
        `;

        const html = `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>${style}</style>
            </head>
            <body>
                <div id="focusModeIndicator" class="focus-mode-indicator">Focus Mode Active</div>
                
                <div class="section">
                    <div class="section-title">Focus Timer</div>
                    <div class="timer" id="timer">25:00</div>
                    <div class="controls">
                        <button onclick="startPomodoro()">Start Pomodoro</button>
                        <button onclick="toggleFocusMode()">Toggle Focus Mode</button>
                        <button onclick="openSettings()">Settings</button>
                    </div>
                </div>

                <div id="settingsSection" class="section" style="display: none;">
                    <div class="section-title">Settings</div>
                    
                    <div class="settings-group">
                        <div class="settings-group-title">Task Statuses</div>
                        <div class="settings-row">
                            <input type="text" id="newStatus" placeholder="New status name" class="settings-input">
                            <button onclick="addNewStatus()" class="settings-button">Add Status</button>
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">Environments</div>
                        <div class="settings-row">
                            <input type="text" id="newEnvironment" placeholder="New environment name" class="settings-input">
                            <button onclick="addNewEnvironment()" class="settings-button">Add Environment</button>
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">Pomodoro Settings</div>
                        <div class="settings-row">
                            <label>Work Duration (minutes):</label>
                            <input type="number" id="workDuration" min="1" max="60" class="settings-input">
                        </div>
                        <div class="settings-row">
                            <label>Short Break Duration (minutes):</label>
                            <input type="number" id="shortBreakDuration" min="1" max="30" class="settings-input">
                        </div>
                        <div class="settings-row">
                            <label>Long Break Duration (minutes):</label>
                            <input type="number" id="longBreakDuration" min="1" max="60" class="settings-input">
                        </div>
                        <div class="settings-row">
                            <label>Long Break Interval (pomodoros):</label>
                            <input type="number" id="longBreakInterval" min="1" max="10" class="settings-input">
                        </div>
                        <button onclick="updatePomodoroSettings()" class="settings-button">Save Pomodoro Settings</button>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">Focus Mode Settings</div>
                        <div class="settings-row">
                            <input type="checkbox" id="hideSidebar">
                            <label for="hideSidebar">Hide Sidebar</label>
                        </div>
                        <div class="settings-row">
                            <input type="checkbox" id="hideActivityBar">
                            <label for="hideActivityBar">Hide Activity Bar</label>
                        </div>
                        <div class="settings-row">
                            <input type="checkbox" id="hideStatusBar">
                            <label for="hideStatusBar">Hide Status Bar</label>
                        </div>
                        <div class="settings-row">
                            <input type="checkbox" id="hidePanel">
                            <label for="hidePanel">Hide Panel</label>
                        </div>
                        <div class="settings-row">
                            <input type="checkbox" id="hideMinimap">
                            <label for="hideMinimap">Hide Minimap</label>
                        </div>
                        <div class="settings-row">
                            <input type="checkbox" id="hideLineNumbers">
                            <label for="hideLineNumbers">Hide Line Numbers</label>
                        </div>
                        <button onclick="updateFocusModeSettings()" class="settings-button">Save Focus Mode Settings</button>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">Notification Settings</div>
                        <div class="settings-row">
                            <input type="checkbox" id="enableInactivityAlerts">
                            <label for="enableInactivityAlerts">Enable Inactivity Alerts</label>
                        </div>
                        <div class="settings-row">
                            <label>Inactivity Threshold (minutes):</label>
                            <input type="number" id="inactivityThreshold" min="1" max="60" class="settings-input">
                        </div>
                        <div class="settings-row">
                            <input type="checkbox" id="enablePomodoroNotifications">
                            <label for="enablePomodoroNotifications">Enable Pomodoro Notifications</label>
                        </div>
                        <div class="settings-row">
                            <input type="checkbox" id="enableTaskReminders">
                            <label for="enableTaskReminders">Enable Task Reminders</label>
                        </div>
                        <button onclick="updateNotificationSettings()" class="settings-button">Save Notification Settings</button>
                    </div>
                </div>

                <div class="section">
                    <div class="section-title">Add Task</div>
                    <div class="task-form">
                        <div class="form-group">
                            <label for="jiraId">JIRA Ticket Number</label>
                            <input type="text" id="jiraId" placeholder="e.g., PROJ-123">
                        </div>
                        <div class="form-group">
                            <label for="status">Status</label>
                            <select id="status">
                                <option value="dev">Development</option>
                                <option value="code_review">Code Review</option>
                                <option value="to_deploy">To Deploy</option>
                                <option value="deployed">Deployed</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label for="environment">Environment</label>
                            <select id="environment">
                                <option value="dev">Development</option>
                                <option value="centest">Centest</option>
                                <option value="uat">UAT</option>
                                <option value="weekc">Weekc</option>
                                <option value="production">Production</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label for="notes">Task Notes</label>
                            <textarea id="notes" placeholder="Add notes about this task..."></textarea>
                        </div>
                        <div class="form-group">
                            <label>Select Files</label>
                            <div id="fileSelection" class="file-selection">
                                <!-- File checkboxes will be populated here -->
                            </div>
                        </div>
                        <button onclick="addTask()">Add Task</button>
                    </div>
                </div>

                <div class="section">
                    <div class="section-title">Tasks</div>
                    <div class="filter-controls">
                        <div class="filter-group">
                            <label for="statusFilter">Filter by Status:</label>
                            <select id="statusFilter" onchange="applyFilters()">
                                <option value="all">All Statuses</option>
                                <option value="dev">Development</option>
                                <option value="code_review">Code Review</option>
                                <option value="to_deploy">To Deploy</option>
                                <option value="deployed">Deployed</option>
                            </select>
                        </div>
                        <div class="filter-group">
                            <label for="envFilter">Filter by Environment:</label>
                            <select id="envFilter" onchange="applyFilters()">
                                <option value="all">All Environments</option>
                                <option value="dev">Development</option>
                                <option value="centest">Centest</option>
                                <option value="uat">UAT</option>
                                <option value="weekc">Weekc</option>
                                <option value="production">Production</option>
                            </select>
                        </div>
                    </div>
                    <div class="task-list" id="taskList"></div>
                </div>

                <script>${script}</script>
            </body>
            </html>`;
        
        return html;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            try {
                switch (data.type) {
                    case 'addTask':
                        await this._addTask(data.jiraId, data.notes, data.status, data.environment, data.selectedFiles);
                        break;
                    case 'deleteTask':
                        await this._deleteTask(data.index);
                        break;
                    case 'updateTask':
                        await this._updateTask(data.index, data.updates);
                        break;
                    case 'addTaskStatus':
                        await this._saveSettings({
                            taskStatuses: [...this._settings.taskStatuses, data.status]
                        });
                        break;
                    case 'addEnvironment':
                        await this._saveSettings({
                            environments: [...this._settings.environments, data.environment]
                        });
                        break;
                    case 'updatePomodoroSettings':
                        await this._saveSettings({
                            pomodoro: data.settings
                        });
                        break;
                    case 'updateFocusModeSettings':
                        await this._saveSettings({
                            focusMode: data.settings
                        });
                        break;
                    case 'updateNotificationSettings':
                        await this._saveSettings({
                            notifications: data.settings
                        });
                        break;
                    case 'startPomodoro':
                        this._startPomodoro();
                        break;
                    case 'toggleFocusMode':
                        this._toggleFocusMode();
                        break;
                    case 'requestTasks':
                        this._updateWebview();
                        break;
                    case 'requestProjectFiles':
                        const files = await this._getProjectFiles();
                        webviewView.webview.postMessage({
                            type: 'updateProjectFiles',
                            files: files
                        });
                        break;
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Error: ${message}`);
            }
        });

        // Send initial settings to webview
        webviewView.webview.postMessage({
            type: 'updateSettings',
            settings: this._settings
        });

        this._updateWebview();
    }
}

export function activate(context: vscode.ExtensionContext): void {
    try {
        const provider = new AlexProvider(context.extensionUri, context);
        
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(AlexProvider.viewType, provider)
        );
        
        context.subscriptions.push(
            vscode.commands.registerCommand('alex.startPomodoro', () => {
                provider['_startPomodoro']();
            })
        );
        
        context.subscriptions.push(
            vscode.commands.registerCommand('alex.toggleFocusMode', () => {
                provider['_toggleFocusMode']();
            })
        );

        vscode.window.showInformationMessage('Alex - ADHD Buddy is now active!');
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Error activating Alex: ${message}`);
    }
}

export function deactivate(): void {
    // Clean up any resources
} 