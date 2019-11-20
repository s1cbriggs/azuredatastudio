/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as constants from '../constants';
import * as azdata from 'azdata';
import * as events from 'events';
import * as nls from 'vscode-nls';
import * as path from 'path';
import * as vscode from 'vscode';
import CredentialServiceTokenCache from './tokenCache';
import providerSettings from './providerSettings';
import { AzureAccountProvider } from './azureAccountProvider';
import { AzureAccountProviderMetadata, ProviderSettings } from './interfaces';

// ///// Start cut\paste azure-account
import { DeviceTokenCredentials, AzureEnvironment } from 'ms-rest-azure';
import * as http from 'http';
import * as https from 'https';
import { ServiceClientCredentials } from 'ms-rest';
import { SubscriptionClient, SubscriptionModels } from 'azure-arm-resource';
import { ReadStream } from 'fs';
import * as codeFlowLogin from './codeFlowLogin';
import * as keytarType from 'keytar';
import { MemoryCache, AuthenticationContext, UserCodeInfo } from 'adal-node';
import { TokenResponse } from 'adal-node';

const CacheDriver = require('adal-node/lib/cache-driver');
const createLogContext = require('adal-node/lib/log').createLogContext;
// ///// End cut\paste azure-account

let localize = nls.loadMessageBundle();

// ///// Start cut\paste azure-account
type LoginTrigger = 'activation' | 'login' | 'loginWithDeviceCode' | 'loginToCloud' | 'cloudChange' | 'tenantChange';
type CodePath = 'tryExisting' | 'newLogin' | 'newLoginCodeFlow' | 'newLoginDeviceCode';
export type AzureLoginStatus = 'Initializing' | 'LoggingIn' | 'LoggedIn' | 'LoggedOut';
export type AzureResourceFilter = AzureSubscription;

const keytar = getNodeModule<typeof keytarType>('keytar');

declare const __webpack_require__: typeof require;
declare const __non_webpack_require__: typeof require;
function getNodeModule<T>(moduleName: string): T | undefined {
	const r = typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;
	try {
		return r(`${vscode.env.appRoot}/node_modules.asar/${moduleName}`);
	} catch (err) {
		// Not in ASAR.
	}
	try {
		return r(`${vscode.env.appRoot}/node_modules/${moduleName}`);
	} catch (err) {
		// Not available.
	}
	return undefined;
}

class ProxyTokenCache {

	public initEnd?: () => void;
	private init = new Promise(resolve => {
		this.initEnd = resolve;
	});

	constructor(private target: any) {
	}

	remove(entries: any, callback: any) {
		this.target.remove(entries, callback)
	}

	add(entries: any, callback: any) {
		this.target.add(entries, callback)
	}

	find(query: any, callback: any) {
		this.init.then(() => {
			this.target.find(query, callback);
		});
	}
}

function getErrorMessage(err: any): string | undefined {
	if (!err) {
		return undefined;
	}

	if (err.message && typeof err.message === 'string') {
		return err.message;
	}

	if (err.stack && typeof err.stack === 'string') {
		return err.stack.split('\n')[0];
	}

	const str = String(err);
	if (!str || str === '[object Object]') {
		const ctr = err.constructor;
		if (ctr && ctr.name && typeof ctr.name === 'string') {
			return ctr.name;
		}
	}

	return str;
}

export interface AzureAccount {
	readonly status: AzureLoginStatus;
	readonly onStatusChanged: vscode.Event<AzureLoginStatus>;
	readonly waitForLogin: () => Promise<boolean>;
	readonly sessions: AzureSession[];
	readonly onSessionsChanged: vscode.Event<void>;
	readonly subscriptions: AzureSubscription[];
	readonly onSubscriptionsChanged: vscode.Event<void>;
	readonly waitForSubscriptions: () => Promise<boolean>;
	readonly filters: AzureResourceFilter[];
	readonly onFiltersChanged: vscode.Event<void>;
	readonly waitForFilters: () => Promise<boolean>;
	createCloudShell(os: 'Linux' | 'Windows'): CloudShell;
}

const clientId = 'aebc6443-996d-45c2-90f0-388ff96faa56'; // VSC: 'aebc6443-996d-45c2-90f0-388ff96faa56'
const commonTenantId = 'common';
const credentialsSection = 'VS Code Azure';
const validateAuthority = true;

export type CloudShellStatus = 'Connecting' | 'Connected' | 'Disconnected';

export interface UploadOptions {
	contentLength?: number;
	progress?: vscode.Progress<{ message?: string; increment?: number }>;
	token?: vscode.CancellationToken;
}

export interface CloudShell {
	readonly status: CloudShellStatus;
	readonly onStatusChanged: vscode.Event<CloudShellStatus>;
	readonly waitForConnection: () => Promise<boolean>;
	readonly terminal: Promise<vscode.Terminal>;
	readonly session: Promise<AzureSession>;
	readonly uploadFile: (filename: string, stream: ReadStream, options?: UploadOptions) => Promise<void>;
}

export interface AzureSession {
	readonly environment: AzureEnvironment;
	readonly userId: string;
	readonly tenantId: string;
	readonly credentials: ServiceClientCredentials;
}

export interface AzureSubscription {
	readonly session: AzureSession;
	readonly subscription: SubscriptionModels.Subscription;
}

const staticEnvironments: AzureEnvironment[] = [
	AzureEnvironment.Azure,
	AzureEnvironment.AzureChina,
	AzureEnvironment.AzureGermanCloud,
	AzureEnvironment.AzureUSGovernment
];

const azurePPE = 'AzurePPE';

function getSelectedEnvironment(): AzureEnvironment {
	const envConfig = vscode.workspace.getConfiguration('azure');
	const envSetting = envConfig.get<string>('cloud');
	return getEnvironments().find((environment: any) => environment.name === envSetting) || AzureEnvironment.Azure;
}


async function storeRefreshToken(environment: AzureEnvironment, token: string) {
	if (keytar) {
		try {
			await keytar.setPassword(credentialsSection, environment.name, token);
		} catch (err) {
			// ignore
		}
	}
}

function getEnvironments() {
	const config = vscode.workspace.getConfiguration('azure');
	const ppe = config.get<AzureEnvironment>('ppe');
	if (ppe) {
		return [
			...staticEnvironments,
			{
				...ppe,
				name: azurePPE
			}
		]
	} else {
		return staticEnvironments;
	}
}

async function clearTokenCache(tokenCache: any) {
	await new Promise<void>((resolve, reject) => {
		tokenCache.find({}, (err: any, entries: any[]) => {
			if (err) {
				reject(err);
			} else {
				tokenCache.remove(entries, (err: any) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			}
		});
	});
}

function timeout(ms: number, result: any = 'timeout') {
	return new Promise<never>((_, reject) => setTimeout(() => reject(result), ms));
}

function delay<T = void>(ms: number, result?: T) {
	return new Promise<T>(resolve => setTimeout(() => resolve(result), ms));
}

async function asyncOr<A, B>(a: Promise<A>, b: Promise<B>) {
	return Promise.race([awaitAOrB(a, b), awaitAOrB(b, a)]);
}

async function awaitAOrB<A, B>(a: Promise<A>, b: Promise<B>) {
	return (await a) || b;
}

async function openUri(uri: string) {
	await vscode.env.openExternal(vscode.Uri.parse(uri));
}

async function isOnline(environment: AzureEnvironment) {
	try {
		await new Promise<http.IncomingMessage | any>((resolve, reject) => {
			const url = environment.activeDirectoryEndpointUrl;
			(url.startsWith('https:') ? https : http).get(url, resolve)
				.on('error', reject);
		});
		return true;
	} catch (err) {
		console.warn(err);
		return false;
	}
}


async function deviceLogin1(environment: AzureEnvironment, tenantId: string): Promise<UserCodeInfo> {
	return new Promise<UserCodeInfo>((resolve, reject) => {
		const cache = new MemoryCache();
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`, validateAuthority, cache);
		context.acquireUserCode(environment.activeDirectoryResourceId, clientId, 'en-us', (err, response) => {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.userCodeFailed', "Acquiring user code failed"), err));
			} else {
				resolve(response);
			}
		});
	});
}

async function deviceLogin2(environment: AzureEnvironment, tenantId: string, deviceLogin: UserCodeInfo) {
	return new Promise<TokenResponse>((resolve, reject) => {
		const tokenCache = new MemoryCache();
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`, validateAuthority, tokenCache);
		context.acquireTokenWithDeviceCode(`${environment.managementEndpointUrl}`, clientId, deviceLogin, (err, tokenResponse) => {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.tokenFailed', "Acquiring token with device code failed"), err));
			} else if (tokenResponse.error) {
				reject(new AzureLoginError(localize('azure-account.tokenFailed', "Acquiring token with device code failed"), tokenResponse));
			} else {
				resolve(<TokenResponse>tokenResponse);
			}
		});
	});
}

async function showDeviceCodeMessage(deviceLogin: UserCodeInfo): Promise<void> {
	const copyAndOpen: vscode.MessageItem = { title: localize('azure-account.copyAndOpen', "Copy & Open") };
	const response = await vscode.window.showInformationMessage(deviceLogin.message, copyAndOpen);
	if (response === copyAndOpen) {
		vscode.env.clipboard.writeText(deviceLogin.userCode);
		await openUri(deviceLogin.verificationUrl);
	} else {
		return Promise.reject('user canceled');
	}
}

async function deviceLogin(environment: AzureEnvironment, tenantId: string) {
	const deviceLogin = await deviceLogin1(environment, tenantId);
	const message = showDeviceCodeMessage(deviceLogin);
	const login2 = deviceLogin2(environment, tenantId, deviceLogin);
	return Promise.race([login2, message.then(() => Promise.race([login2, timeout(3 * 60 * 1000)]))]); // 3 minutes
}

async function redirectTimeout() {
	const response = await vscode.window.showInformationMessage('Browser did not connect to local server within 10 seconds. Do you want to try the alternate sign in using a device code instead?', 'Use Device Code');
	if (response) {
		await vscode.commands.executeCommand('azure-account.loginWithDeviceCode');
	}
}

async function becomeOnline(environment: AzureEnvironment, interval: number, token = new vscode.CancellationTokenSource().token) {
	let o = isOnline(environment);
	let d = delay(interval, false);
	while (!token.isCancellationRequested && !await Promise.race([o, d])) {
		await d;
		o = asyncOr(o, isOnline(environment));
		d = delay(interval, false);
	}
}

interface AzureAccountWriteable extends AzureAccount {
	status: AzureLoginStatus;
}

class AzureLoginError extends Error {
	constructor(message: string, public reason?: any) {
		super(message);
	}
}

function getTenantId() {
	const envConfig = vscode.workspace.getConfiguration('azure');
	return envConfig.get<string>('tenant') || commonTenantId;
}

async function addTokenToCache(environment: AzureEnvironment, tokenCache: any, tokenResponse: TokenResponse) {
	return new Promise<any>((resolve, reject) => {
		const driver = new CacheDriver(
			{ _logContext: createLogContext('') },
			`${environment.activeDirectoryEndpointUrl}${tokenResponse.tenantId}`,
			tokenResponse.resource,
			clientId,
			tokenCache,
			(entry: any, resource: any, callback: (err: any, response: any) => {}) => {
				callback(null, entry);
			}
		);
		driver.add(tokenResponse, function (err: any) {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
}

export interface PartialList<T> extends Array<T> {
	nextLink?: string;
}

export async function listAll<T>(client: { listNext(nextPageLink: string): Promise<PartialList<T>>; }, first: Promise<PartialList<T>>): Promise<T[]> {
	const all: T[] = [];
	for (let list = await first; list.length || list.nextLink; list = list.nextLink ? await client.listNext(list.nextLink) : []) {
		all.push(...list);
	}
	return all;
}

export async function tokenFromRefreshToken(environment: AzureEnvironment, refreshToken: string, tenantId: string, resource?: string) {
	return new Promise<TokenResponse>((resolve, reject) => {
		const tokenCache = new MemoryCache();
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`, validateAuthority, tokenCache);
		context.acquireTokenWithRefreshToken(refreshToken, clientId, <any>resource, (err, tokenResponse) => {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.tokenFromRefreshTokenFailed', "Acquiring token with refresh token failed"), err));
			} else if (tokenResponse.error) {
				reject(new AzureLoginError(localize('azure-account.tokenFromRefreshTokenFailed', "Acquiring token with refresh token failed"), tokenResponse));
			} else {
				resolve(<TokenResponse>tokenResponse);
			}
		});
	});
}

async function tokensFromToken(environment: AzureEnvironment, firstTokenResponse: TokenResponse) {
	const tokenCache = new MemoryCache();
	await addTokenToCache(environment, tokenCache, firstTokenResponse);
	const credentials = new DeviceTokenCredentials({ username: firstTokenResponse.userId, clientId, tokenCache, environment });
	const client = new SubscriptionClient.SubscriptionClient(credentials, environment.resourceManagerEndpointUrl);
	const tenants = await listAll(client.tenants, client.tenants.list());
	const responses = <TokenResponse[]>(await Promise.all<TokenResponse | null>(tenants.map((tenant, i) => {
		if (tenant.tenantId === firstTokenResponse.tenantId) {
			return firstTokenResponse;
		}
		return tokenFromRefreshToken(environment, firstTokenResponse.refreshToken!, tenant.tenantId!)
			.catch(err => {
				console.error(err instanceof AzureLoginError && err.reason ? err.reason : err);
				return null;
			});
	}))).filter(r => r);
	if (!responses.some(response => response.tenantId === firstTokenResponse.tenantId)) {
		responses.unshift(firstTokenResponse);
	}
	return responses;
}

// ///// End cut\paste azure-account

export class AzureAccountProviderService implements vscode.Disposable {
	// CONSTANTS ///////////////////////////////////////////////////////////////
	private static CommandClearTokenCache = 'accounts.clearTokenCache';
	private static ConfigurationSection = 'accounts.azure';
	private static CredentialNamespace = 'azureAccountProviderCredentials';

	// MEMBER VARIABLES ////////////////////////////////////////////////////////
	private _accountDisposals: { [accountProviderId: string]: vscode.Disposable };
	private _accountProviders: { [accountProviderId: string]: AzureAccountProvider };
	private _credentialProvider: azdata.CredentialProvider;
	private _configChangePromiseChain: Thenable<void>;
	private _currentConfig: vscode.WorkspaceConfiguration;
	private _event: events.EventEmitter;

	constructor(private _context: vscode.ExtensionContext, private _userStoragePath: string) {
		this._accountDisposals = {};
		this._accountProviders = {};
		this._configChangePromiseChain = Promise.resolve();
		this._currentConfig = null;
		this._event = new events.EventEmitter();
	}

	// ///// Start cut\paste azure-account
	private onStatusChanged = new vscode.EventEmitter<AzureLoginStatus>();

	private subscriptions = Promise.resolve(<AzureSubscription[]>[]);

	private tokenCache = new MemoryCache();

	private delayedCache = new ProxyTokenCache(this.tokenCache);

	private onSessionsChanged = new vscode.EventEmitter<void>();
	private onSubscriptionsChanged = new vscode.EventEmitter<void>();
	private onFiltersChanged = new vscode.EventEmitter<void>();
	private filters = Promise.resolve(<AzureResourceFilter[]>[]);


	api: AzureAccount = {
		status: 'Initializing',
		onStatusChanged: this.onStatusChanged.event,
		waitForLogin: () => this.waitForLogin(),
		sessions: [],
		onSessionsChanged: this.onSessionsChanged.event,
		subscriptions: [],
		onSubscriptionsChanged: this.onSubscriptionsChanged.event,
		waitForSubscriptions: () => this.waitForSubscriptions(),
		filters: [],
		onFiltersChanged: this.onFiltersChanged.event,
		waitForFilters: () => this.waitForFilters(),
		//createCloudShell: os => createCloudConsole(this.api, undefined, os)
		createCloudShell: undefined
	};

	private async waitForLogin() {
		switch (this.api.status) {
			case 'LoggedIn':
				return true;
			case 'LoggedOut':
				return false;
			case 'Initializing':
			case 'LoggingIn':
				return new Promise<boolean>(resolve => {
					const subscription = this.api.onStatusChanged(() => {
						subscription.dispose();
						resolve(this.waitForLogin());
					});
				});
			default:
				const status: never = this.api.status;
				throw new Error(`Unexpected status '${status}'`);
		}
	}

	private beginLoggingIn() {
		if (this.api.status !== 'LoggedIn') {
			(<AzureAccountWriteable>this.api).status = 'LoggingIn';
			this.onStatusChanged.fire(this.api.status);
		}
	}

	private async waitForFilters() {
		if (!(await this.waitForSubscriptions())) {
			return false;
		}
		await this.filters;
		return true;
	}

	async testLogin(trigger: LoginTrigger) {
		console.log('test login callback1');

		let path: CodePath = 'newLogin';
		let environmentName = 'uninitialized';
		const cancelSource = new vscode.CancellationTokenSource();
		try {
			const environment = getSelectedEnvironment();
			environmentName = environment.name;
			const online = becomeOnline(environment, 2000, cancelSource.token);
			const timer = delay(2000, true);
			if (await Promise.race([ online, timer ])) {
				const cancel = { title: localize('azure-account.cancel', "Cancel") };
				await Promise.race([
					online,
					vscode.window.showInformationMessage(localize('azure-account.checkNetwork', "You appear to be offline. Please check your network connection."), cancel)
						.then(result => {
							if (result === cancel) {
								throw new AzureLoginError(localize('azure-account.offline', "Offline"));
							}
						})
				]);
				await online;
			}
			this.beginLoggingIn();
			const tenantId = getTenantId();
			const adfs = codeFlowLogin.isADFS(environment);
			const useCodeFlow = trigger !== 'loginWithDeviceCode' && await codeFlowLogin.checkRedirectServer(adfs);
			path = useCodeFlow ? 'newLoginCodeFlow' : 'newLoginDeviceCode';
			const tokenResponse = await (useCodeFlow ? codeFlowLogin.login(clientId, environment, adfs, tenantId, openUri, () => redirectTimeout()) : deviceLogin(environment, tenantId));
			const refreshToken = tokenResponse.refreshToken!;
			const tokenResponses = tenantId === commonTenantId ? await tokensFromToken(environment, tokenResponse) : [tokenResponse];
			await storeRefreshToken(environment, refreshToken);
			await this.updateSessions(environment, tokenResponses);
			this.sendLoginTelemetry(trigger, path, environmentName, 'success', undefined, true);
		} catch (err) {
			if (err instanceof AzureLoginError && err.reason) {
				console.error(err.reason);
				this.sendLoginTelemetry(trigger, path, environmentName, 'error', getErrorMessage(err.reason) || getErrorMessage(err));
			} else {
				this.sendLoginTelemetry(trigger, path, environmentName, 'failure', getErrorMessage(err));
			}
			throw err;
		} finally {
			cancelSource.cancel();
			cancelSource.dispose();
			this.updateStatus();
		}
	}


	private async waitForSubscriptions() {
		if (!(await this.api.waitForLogin())) {
			return false;
		}
		await this.subscriptions;
		return true;
	}

	async sendLoginTelemetry(trigger: LoginTrigger, path: CodePath, cloud: string, outcome: string, message?: string, includeSubscriptions?: boolean) {
		/* __GDPR__
		   "login" : {
			  "trigger" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "path": { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "cloud" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "outcome" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "message": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" },
			  "subscriptions" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "endPoint": "AzureSubscriptionId" }
		   }
		 */
		const event: Record<string, string> = { trigger, path, cloud, outcome };
		if (message) {
			event.message = message;
		}
		if (includeSubscriptions) {
			await this.waitForSubscriptions();
			event.subscriptions = JSON.stringify((await this.subscriptions).map(s => s.subscription.subscriptionId!));
		}
		// this.reporter.sendTelemetryEvent('login', event);
	}

	private updateStatus() {
		const status = this.api.sessions.length ? 'LoggedIn' : 'LoggedOut';
		if (this.api.status !== status) {
			(<AzureAccountWriteable>this.api).status = status;
			this.onStatusChanged.fire(this.api.status);
		}
	}

	private async updateSessions(environment: AzureEnvironment, tokenResponses: TokenResponse[]) {
		await clearTokenCache(this.tokenCache);
		for (const tokenResponse of tokenResponses) {
			await addTokenToCache(environment, this.tokenCache, tokenResponse);
		}
		this.delayedCache.initEnd!();
		const sessions = this.api.sessions;
		sessions.splice(0, sessions.length, ...tokenResponses.map<AzureSession>(tokenResponse => ({
			environment,
			userId: tokenResponse.userId!,
			tenantId: tokenResponse.tenantId!,
			credentials: new DeviceTokenCredentials({ environment: environment, username: tokenResponse.userId, clientId, tokenCache: this.delayedCache, domain: tokenResponse.tenantId })
		})));
		this.onSessionsChanged.fire();
	}

	// ///// End cut\paste azure-account

	// PUBLIC METHODS //////////////////////////////////////////////////////
	public activate(): Thenable<boolean> {
		let self = this;

		// Register commands
		this._context.subscriptions.push(vscode.commands.registerCommand(
			AzureAccountProviderService.CommandClearTokenCache,
			() => { self._event.emit(AzureAccountProviderService.CommandClearTokenCache); }
		));
		this._event.on(AzureAccountProviderService.CommandClearTokenCache, () => { self.onClearTokenCache(); });

		this._context.subscriptions.push(vscode.commands.registerCommand('azure.resource.login', () => this.testLogin('login')));

		// 1) Get a credential provider
		// 2a) Store the credential provider for use later
		// 2b) Register the configuration change handler
		// 2c) Perform an initial config change handling
		return azdata.credentials.getProvider(AzureAccountProviderService.CredentialNamespace)
			.then(credProvider => {
				self._credentialProvider = credProvider;

				self._context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(self.onDidChangeConfiguration, self));
				self.onDidChangeConfiguration();
				return true;
			});
	}

	public dispose() { }

	// PRIVATE HELPERS /////////////////////////////////////////////////////
	private onClearTokenCache(): Thenable<void> {
		let self = this;

		let promises: Thenable<void>[] = providerSettings.map(provider => {
			return self._accountProviders[provider.metadata.id].clearTokenCache();
		});

		return Promise.all(promises)
			.then(
				() => {
					let message = localize('clearTokenCacheSuccess', "Token cache successfully cleared");
					vscode.window.showInformationMessage(`${constants.extensionName}: ${message}`);
				},
				err => {
					let message = localize('clearTokenCacheFailure', "Failed to clear token cache");
					vscode.window.showErrorMessage(`${constants.extensionName}: ${message}: ${err}`);
				});
	}

	private onDidChangeConfiguration(): void {
		let self = this;

		// Add a new change processing onto the existing promise change
		this._configChangePromiseChain = this._configChangePromiseChain.then(() => {
			// Grab the stored config and the latest config
			let newConfig = vscode.workspace.getConfiguration(AzureAccountProviderService.ConfigurationSection);
			let oldConfig = self._currentConfig;
			self._currentConfig = newConfig;

			// Determine what providers need to be changed
			let providerChanges: Thenable<void>[] = [];
			for (let provider of providerSettings) {
				// If the old config doesn't exist, then assume everything was disabled
				// There will always be a new config value
				let oldConfigValue = oldConfig
					? oldConfig.get<boolean>(provider.configKey)
					: false;
				let newConfigValue = newConfig.get<boolean>(provider.configKey);

				// Case 1: Provider config has not changed - do nothing
				if (oldConfigValue === newConfigValue) {
					continue;
				}

				// Case 2: Provider was enabled and is now disabled - unregister provider
				if (oldConfigValue && !newConfigValue) {
					providerChanges.push(self.unregisterAccountProvider(provider));
				}

				// Case 3: Provider was disabled and is now enabled - register provider
				if (!oldConfigValue && newConfigValue) {
					providerChanges.push(self.registerAccountProvider(provider));
				}
			}

			// Process all the changes before continuing
			return Promise.all(providerChanges);
		}).then(null, () => { return Promise.resolve(); });
	}

	private registerAccountProvider(provider: ProviderSettings): Thenable<void> {
		let self = this;

		return new Promise((resolve, reject) => {
			try {
				let tokenCacheKey = `azureTokenCache-${provider.metadata.id}`;
				let tokenCachePath = path.join(this._userStoragePath, tokenCacheKey);
				let tokenCache = new CredentialServiceTokenCache(self._credentialProvider, tokenCacheKey, tokenCachePath);
				let accountProvider = new AzureAccountProvider(<AzureAccountProviderMetadata>provider.metadata, tokenCache);
				self._accountProviders[provider.metadata.id] = accountProvider;
				self._accountDisposals[provider.metadata.id] = azdata.accounts.registerAccountProvider(provider.metadata, accountProvider);
				resolve();
			} catch (e) {
				console.error(`Failed to register account provider: ${e}`);
				reject(e);
			}
		});
	}

	private unregisterAccountProvider(provider: ProviderSettings): Thenable<void> {
		let self = this;

		return new Promise((resolve, reject) => {
			try {
				self._accountDisposals[provider.metadata.id].dispose();
				delete self._accountProviders[provider.metadata.id];
				delete self._accountDisposals[provider.metadata.id];
				resolve();
			} catch (e) {
				console.error(`Failed to unregister account provider: ${e}`);
				reject(e);
			}
		});
	}
}
