import 'regenerator-runtime/runtime';
import bindAll from 'lodash.bindall';
import debounce from 'lodash.debounce';
import PropTypes from 'prop-types';
import React from 'react';
import ReactModal from 'react-modal';
import {FormattedMessage} from 'react-intl';
import {connect} from 'react-redux';
import VM from 'scratch-vm';

import log from './log';
import {getIsShowingProject} from '../reducers/project-state';

import styles from './folder-auto-save-hoc.css';

const DB_NAME = 'handpose2scratch-auto-save';
const DB_STORE = 'handles';
const DB_KEY = 'folder';
const PICKER_ID = 'handpose2scratch-auto-save';

const DEFAULT_TITLE = 'Scratch Project';
const MAX_TITLE_LENGTH = 100;

const SAVE_DEBOUNCE_MS = 1000;
const SAVE_MAX_WAIT_MS = 5000;
const NOTICE_DURATION_MS = 10000;

const STATUS_OFF = 'off';
const STATUS_ON = 'on';
const STATUS_SAVING = 'saving';
const STATUS_SAVED = 'saved';
const STATUS_FAILED = 'failed';

// Undefined in Firefox, Safari and on insecure origins.
const isSupported = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

const withStore = (mode, run) => new Promise((resolve, reject) => {
    const open = window.indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(DB_STORE, mode);
        const request = run(tx.objectStore(DB_STORE));
        tx.oncomplete = () => {
            db.close();
            resolve(request.result);
        };
        tx.onabort = () => {
            db.close();
            reject(tx.error);
        };
    };
});
const loadStoredFolder = () => withStore('readonly', store => store.get(DB_KEY));
const rememberFolder = folder => withStore('readwrite', store => store.put(folder, DB_KEY));

const getFileName = title => {
    const safeTitle = (title || '')
        .substring(0, MAX_TITLE_LENGTH)
        .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_') // eslint-disable-line no-control-regex
        .trim();
    return `${safeTitle || DEFAULT_TITLE}.sb3`;
};

const fileExists = (folder, fileName) => folder.getFileHandle(fileName).then(
    () => true,
    error => {
        if (error.name === 'NotFoundError') return false;
        throw error;
    }
);

const writeFile = async (folder, fileName, blob) => {
    const file = await folder.getFileHandle(fileName, {create: true});
    const writable = await file.createWritable();
    try {
        await writable.write(blob);
        await writable.close();
    } catch (error) {
        // Discards the temporary file; the existing file has not been touched.
        await writable.abort().catch(() => {});
        throw error;
    }
};

/**
 * Higher Order Component that asks for a local folder when the editor loads,
 * then writes the project into it as <title>.sb3 after each modification.
 * @param {React.Component} WrappedComponent component to render alongside the auto-save UI
 * @returns {React.Component} connected component with folder auto-save behaviour
 */
const FolderAutoSaveHOC = function (WrappedComponent) {
    class FolderAutoSave extends React.Component {
        constructor (props) {
            super(props);
            bindAll(this, [
                'handleChooseFolder',
                'handleContinueWithFolder',
                'handleDismissNotice',
                'handleNotNow',
                'handleOpenDialog',
                'handleProjectChanged',
                'save'
            ]);
            this.folder = null;
            // The project as it was last loaded or written; matching it means there is nothing to save.
            this.baseline = null;
            // Bumped when the project or folder changes, so a write still in flight can't update the new state.
            this.generation = 0;
            this.hasPrompted = false;
            this.isSaving = false;
            this.isSaveQueued = false;
            this.storedFolderLoaded = false;
            this.writtenNames = new Set();
            this.scheduleSave = debounce(this.save, SAVE_DEBOUNCE_MS, {maxWait: SAVE_MAX_WAIT_MS});
            this.state = {
                dialogError: false,
                dialogOpen: false,
                folderName: null,
                noticeFileName: null,
                noticeFolderName: null,
                savedAt: null,
                savedFileName: null,
                status: STATUS_OFF,
                storedFolder: null
            };
        }
        componentDidMount () {
            if (!isSupported) return;
            this.props.vm.on('PROJECT_CHANGED', this.handleProjectChanged);
            loadStoredFolder()
                .then(storedFolder => this.setState({storedFolder: storedFolder || null}))
                .catch(error => log.warn('Could not read the remembered auto-save folder', error))
                .then(() => {
                    this.storedFolderLoaded = true;
                    this.promptIfReady();
                });
            if (this.props.isShowingProject) this.captureBaseline();
        }
        componentDidUpdate (prevProps) {
            if (!isSupported) return;
            if (this.props.isShowingProject && !prevProps.isShowingProject) {
                this.captureBaseline();
            } else if (!this.props.isShowingProject && prevProps.isShowingProject) {
                this.handleProjectLeaving();
            } else if (this.props.projectTitle !== prevProps.projectTitle) {
                this.handleProjectChanged();
            }
            this.promptIfReady();
        }
        componentWillUnmount () {
            if (!isSupported) return;
            this.props.vm.removeListener('PROJECT_CHANGED', this.handleProjectChanged);
            this.scheduleSave.cancel();
            clearTimeout(this.baselineTimer);
            clearTimeout(this.noticeTimer);
        }
        captureBaseline () {
            this.writtenNames.clear();
            // Wait a tick: the default title is set, and stray change events fire, just after a load.
            clearTimeout(this.baselineTimer);
            this.baselineTimer = setTimeout(() => {
                this.baseline = {
                    json: this.props.vm.toJSON(),
                    fileName: getFileName(this.props.projectTitle)
                };
            });
        }
        handleProjectLeaving () {
            // The VM may be half-loaded from here on, so a save now could write a broken project.
            this.scheduleSave.cancel();
            clearTimeout(this.baselineTimer);
            this.baseline = null;
            this.generation++;
        }
        handleProjectChanged () {
            if (this.folder && this.props.isShowingProject) this.scheduleSave();
        }
        promptIfReady () {
            if (this.hasPrompted || !this.storedFolderLoaded || !this.props.isShowingProject) return;
            if (this.isUiHidden()) return;
            this.hasPrompted = true;
            this.setState({dialogOpen: true});
        }
        isUiHidden () {
            return this.props.isPlayerOnly || this.props.isFullScreen;
        }
        activateFolder (folder) {
            this.folder = folder;
            this.generation++;
            this.writtenNames.clear();
            this.setState({
                dialogError: false,
                dialogOpen: false,
                folderName: folder.name,
                status: STATUS_ON,
                storedFolder: folder
            });
            // Picks up edits made before a folder was chosen; does nothing if there are none.
            this.save();
        }
        showOverwriteNotice (fileName, folderName) {
            this.setState({noticeFileName: fileName, noticeFolderName: folderName});
            clearTimeout(this.noticeTimer);
            this.noticeTimer = setTimeout(this.handleDismissNotice, NOTICE_DURATION_MS);
        }
        async save () {
            if (!this.folder || !this.baseline) return;
            if (this.isSaving) {
                this.isSaveQueued = true;
                return;
            }
            const {vm, projectTitle} = this.props;
            const folder = this.folder;
            const generation = this.generation;
            const fileName = getFileName(projectTitle);
            const json = vm.toJSON();
            if (json === this.baseline.json && fileName === this.baseline.fileName) return;

            this.isSaving = true;
            this.setState({status: STATUS_SAVING});
            try {
                const blob = await vm.saveProjectSb3();
                if (!this.writtenNames.has(fileName) && await fileExists(folder, fileName)) {
                    this.showOverwriteNotice(fileName, folder.name);
                }
                await writeFile(folder, fileName, blob);
                if (generation === this.generation) {
                    this.baseline = {json, fileName};
                    this.writtenNames.add(fileName);
                }
                this.setState({
                    savedAt: new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}),
                    savedFileName: fileName,
                    status: STATUS_SAVED
                });
            } catch (error) {
                log.warn('Auto-save failed', error);
                this.setState({status: STATUS_FAILED});
            }
            this.isSaving = false;
            if (this.isSaveQueued) {
                this.isSaveQueued = false;
                this.save();
            }
        }
        handleChooseFolder () {
            // Must stay synchronous with the click: browsers require a user gesture for the picker.
            window.showDirectoryPicker({id: PICKER_ID, mode: 'readwrite'})
                .then(folder => {
                    rememberFolder(folder).catch(error => log.warn('Could not remember the folder', error));
                    this.activateFolder(folder);
                })
                .catch(error => {
                    if (error.name === 'AbortError') return; // The user closed the picker.
                    log.warn('Could not open the folder', error);
                    this.setState({dialogError: true});
                });
        }
        handleContinueWithFolder () {
            const folder = this.state.storedFolder;
            // Must stay synchronous with the click, for the same reason as the picker.
            folder.requestPermission({mode: 'readwrite'})
                .then(permission => {
                    if (permission === 'granted') {
                        this.activateFolder(folder);
                    } else {
                        this.setState({dialogError: true});
                    }
                })
                .catch(error => {
                    log.warn('Could not reopen the folder', error);
                    this.setState({dialogError: true});
                });
        }
        handleNotNow () {
            this.setState({dialogError: false, dialogOpen: false});
        }
        handleOpenDialog () {
            this.setState({dialogOpen: true});
        }
        handleDismissNotice () {
            clearTimeout(this.noticeTimer);
            this.setState({noticeFileName: null, noticeFolderName: null});
        }
        renderStatus () {
            switch (this.state.status) {
            case STATUS_ON:
                return (
                    <FormattedMessage
                        defaultMessage="Auto-save to {folderName}"
                        description="Status button when a folder is chosen but nothing has been saved yet"
                        id="gui.folderAutoSave.statusOn"
                        values={{folderName: this.state.folderName}}
                    />
                );
            case STATUS_SAVING:
                return (
                    <FormattedMessage
                        defaultMessage="Saving…"
                        description="Status button while the project is being written to the folder"
                        id="gui.folderAutoSave.statusSaving"
                    />
                );
            case STATUS_SAVED:
                return (
                    <FormattedMessage
                        defaultMessage="Saved {fileName} · {time}"
                        description="Status button after the project was written to the folder"
                        id="gui.folderAutoSave.statusSaved"
                        values={{fileName: this.state.savedFileName, time: this.state.savedAt}}
                    />
                );
            case STATUS_FAILED:
                return (
                    <FormattedMessage
                        defaultMessage="Auto-save failed"
                        description="Status button when writing to the folder failed"
                        id="gui.folderAutoSave.statusFailed"
                    />
                );
            default:
                return (
                    <FormattedMessage
                        defaultMessage="Auto-save off"
                        description="Status button when no folder has been chosen"
                        id="gui.folderAutoSave.statusOff"
                    />
                );
            }
        }
        renderDialog () {
            const {dialogError, storedFolder} = this.state;
            return (
                <ReactModal
                    isOpen
                    className={styles.modalContent}
                    contentLabel="Choose an auto-save folder"
                    overlayClassName={styles.modalOverlay}
                    onRequestClose={this.handleNotNow}
                >
                    <h2 className={styles.title}>
                        <FormattedMessage
                            defaultMessage="Choose a folder for auto-save"
                            description="Title of the dialog asking for an auto-save folder"
                            id="gui.folderAutoSave.dialogTitle"
                        />
                    </h2>
                    <p className={styles.body}>
                        <FormattedMessage
                            defaultMessage="Your project will be saved to this folder after every change, as a file named after the project. A file with the same name will be overwritten."
                            description="Explanation in the dialog asking for an auto-save folder"
                            id="gui.folderAutoSave.dialogBody"
                        />
                    </p>
                    {dialogError && (
                        <p className={styles.error}>
                            <FormattedMessage
                                defaultMessage="That folder could not be opened. Please try again or choose another one."
                                description="Error in the dialog when the folder could not be opened"
                                id="gui.folderAutoSave.dialogError"
                            />
                        </p>
                    )}
                    <div className={styles.buttons}>
                        <button
                            className={styles.secondaryButton}
                            onClick={this.handleNotNow}
                        >
                            <FormattedMessage
                                defaultMessage="Not now"
                                description="Button that closes the auto-save dialog without choosing a folder"
                                id="gui.folderAutoSave.notNow"
                            />
                        </button>
                        {storedFolder && (
                            <button
                                className={styles.secondaryButton}
                                onClick={this.handleContinueWithFolder}
                            >
                                <FormattedMessage
                                    defaultMessage={'Continue with "{folderName}"'}
                                    description="Button that resumes auto-saving to the last used folder"
                                    id="gui.folderAutoSave.continue"
                                    values={{folderName: storedFolder.name}}
                                />
                            </button>
                        )}
                        <button
                            className={styles.primaryButton}
                            onClick={this.handleChooseFolder}
                        >
                            <FormattedMessage
                                defaultMessage="Choose folder"
                                description="Button that opens the folder picker"
                                id="gui.folderAutoSave.chooseFolder"
                            />
                        </button>
                    </div>
                </ReactModal>
            );
        }
        render () {
            const {
                /* eslint-disable no-unused-vars */
                isFullScreen,
                isPlayerOnly,
                isShowingProject,
                projectTitle,
                /* eslint-enable no-unused-vars */
                ...props
            } = this.props;
            const wrapped = <WrappedComponent {...props} />;
            if (!isSupported || this.isUiHidden()) return wrapped;
            const {dialogOpen, noticeFileName, noticeFolderName, status} = this.state;
            return (
                <React.Fragment>
                    {wrapped}
                    {dialogOpen && this.renderDialog()}
                    <div className={styles.statusArea}>
                        <button
                            className={status === STATUS_FAILED ? styles.statusFailed : styles.status}
                            onClick={this.handleOpenDialog}
                        >
                            {this.renderStatus()}
                        </button>
                        {noticeFileName && (
                            <div
                                className={styles.notice}
                                role="status"
                            >
                                <FormattedMessage
                                    defaultMessage={'Overwriting "{fileName}" in {folderName}'}
                                    description="Notice shown when auto-save replaces a file that already existed"
                                    id="gui.folderAutoSave.overwriting"
                                    values={{fileName: noticeFileName, folderName: noticeFolderName}}
                                />
                                <button
                                    aria-label="Dismiss"
                                    className={styles.noticeDismiss}
                                    onClick={this.handleDismissNotice}
                                >
                                    {'×'}
                                </button>
                            </div>
                        )}
                    </div>
                </React.Fragment>
            );
        }
    }
    FolderAutoSave.propTypes = {
        isFullScreen: PropTypes.bool,
        isPlayerOnly: PropTypes.bool,
        isShowingProject: PropTypes.bool,
        projectTitle: PropTypes.string,
        vm: PropTypes.instanceOf(VM).isRequired
    };
    const mapStateToProps = state => ({
        isFullScreen: state.scratchGui.mode.isFullScreen,
        isPlayerOnly: state.scratchGui.mode.isPlayerOnly,
        isShowingProject: getIsShowingProject(state.scratchGui.projectState.loadingState),
        projectTitle: state.scratchGui.projectTitle,
        vm: state.scratchGui.vm
    });
    return connect(
        mapStateToProps,
        () => ({}) // omit dispatch prop
    )(FolderAutoSave);
};

export default FolderAutoSaveHOC;
