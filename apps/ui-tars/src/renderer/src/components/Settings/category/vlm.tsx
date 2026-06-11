/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useState, useImperativeHandle } from 'react';
import { CheckCircle, XCircle, Loader2, EyeOff, Eye } from 'lucide-react';
import * as z from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { VLMProviderV2 } from '@main/store/types';
import { useSetting } from '@renderer/hooks/useSetting';
import { Button } from '@renderer/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@renderer/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Input } from '@renderer/components/ui/input';
import { Switch } from '@renderer/components/ui/switch';
import { Alert, AlertDescription } from '@renderer/components/ui/alert';
import { cn } from '@renderer/utils';

import { PresetImport, PresetBanner } from './preset';
import { api } from '@/renderer/src/api';

const formSchema = z
  .object({
    vlmProvider: z
      .nativeEnum(VLMProviderV2, {
        message: 'Please select a VLM Provider to enhance resolution',
      })
      .optional()
      .or(z.literal('')),
    vlmBaseUrl: z.string().optional(),
    vlmApiKey: z.string().optional(),
    vlmModelName: z.string().optional(),
    useResponsesApi: z.boolean().default(false),
    // Vertex AI settings
    vertexProjectId: z.string().optional(),
    vertexLocation: z.string().optional(),
    vertexModelName: z.string().optional(),
    vertexChatModelName: z.string().optional(),
    googleApiSource: z.enum(['direct', 'agent_builder']).optional(),
    vertexServiceAccountPath: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.vlmProvider === VLMProviderV2.gemini_vertex) {
      if (!data.vertexProjectId || data.vertexProjectId.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vertexProjectId'],
          message: 'Google Cloud Project ID is required for Vertex AI',
        });
      }
      if (!data.vertexLocation || data.vertexLocation.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vertexLocation'],
          message: 'Google Cloud Location is required for Vertex AI',
        });
      }
    } else if (data.vlmProvider) {
      if (!data.vlmBaseUrl || data.vlmBaseUrl.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vlmBaseUrl'],
          message: 'VLM Base URL is required',
        });
      } else {
        try {
          new URL(data.vlmBaseUrl);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['vlmBaseUrl'],
            message: 'Please enter a valid URL',
          });
        }
      }
      if (!data.vlmApiKey || data.vlmApiKey.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vlmApiKey'],
          message: 'VLM API Key is required',
        });
      }
      if (!data.vlmModelName || data.vlmModelName.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vlmModelName'],
          message: 'VLM Model Name is required',
        });
      }
    }
  });

export interface VLMSettingsRef {
  submit: () => Promise<z.infer<typeof formSchema>>;
}

interface VLMSettingsProps {
  ref?: React.RefObject<VLMSettingsRef | null>;
  autoSave?: boolean;
  className?: string;
}

export function VLMSettings({
  ref,
  autoSave = false,
  className,
}: VLMSettingsProps) {
  const { settings, updateSetting, updatePresetFromRemote } = useSetting();
  const [isPresetModalOpen, setPresetModalOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [responseApiSupported, setResponseApiSupported] = useState<
    boolean | null
  >(null);
  const [isCheckingResponseApi, setIsCheckingResponseApi] = useState(false);
  const [lastSettingsStr, setLastSettingsStr] = useState('');

  const isRemoteAutoUpdatedPreset =
    settings?.presetSource?.type === 'remote' &&
    settings.presetSource.autoUpdate;

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      vlmProvider: undefined,
      vlmBaseUrl: '',
      vlmApiKey: '',
      vlmModelName: '',
      useResponsesApi: false,
      vertexProjectId: '',
      vertexLocation: 'us-central1',
      vertexModelName: 'gemini-2.5-flash',
      vertexChatModelName: 'gemini-2.5-flash',
      googleApiSource: 'direct',
      vertexServiceAccountPath: '',
    },
  });

  useEffect(() => {
    if (Object.keys(settings).length) {
      const currentSettingsStr = JSON.stringify({
        vlmProvider: settings.vlmProvider,
        vlmBaseUrl: settings.vlmBaseUrl || '',
        vlmApiKey: settings.vlmApiKey || '',
        vlmModelName: settings.vlmModelName || '',
        useResponsesApi: settings.useResponsesApi || false,
        vertexProjectId: settings.vertexProjectId || '',
        vertexLocation: settings.vertexLocation || 'us-central1',
        vertexModelName: settings.vertexModelName || 'gemini-2.5-flash',
        vertexChatModelName: settings.vertexChatModelName || 'gemini-2.5-flash',
        googleApiSource: settings.googleApiSource || 'direct',
        vertexServiceAccountPath: settings.vertexServiceAccountPath || '',
      });

      if (currentSettingsStr !== lastSettingsStr) {
        form.reset({
          vlmProvider: settings.vlmProvider,
          vlmBaseUrl: settings.vlmBaseUrl || '',
          vlmApiKey: settings.vlmApiKey || '',
          vlmModelName: settings.vlmModelName || '',
          useResponsesApi: settings.useResponsesApi || false,
          vertexProjectId: settings.vertexProjectId || '',
          vertexLocation: settings.vertexLocation || 'us-central1',
          vertexModelName: settings.vertexModelName || 'gemini-2.5-flash',
          vertexChatModelName:
            settings.vertexChatModelName || 'gemini-2.5-flash',
          googleApiSource: settings.googleApiSource || 'direct',
          vertexServiceAccountPath: settings.vertexServiceAccountPath || '',
        });
        setLastSettingsStr(currentSettingsStr);
      }
    }
  }, [settings, lastSettingsStr, form]);

  const [
    newProvider,
    newBaseUrl,
    newApiKey,
    newModelName,
    newUseResponsesApi,
    newVertexProjectId,
    newVertexLocation,
    newVertexModelName,
    newVertexServiceAccountPath,
    newVertexChatModelName,
    newGoogleApiSource,
  ] = form.watch([
    'vlmProvider',
    'vlmBaseUrl',
    'vlmApiKey',
    'vlmModelName',
    'useResponsesApi',
    'vertexProjectId',
    'vertexLocation',
    'vertexModelName',
    'vertexServiceAccountPath',
    'vertexChatModelName',
    'googleApiSource',
  ]);

  useEffect(() => {
    if (!autoSave) {
      return;
    }
    if (isRemoteAutoUpdatedPreset) {
      return;
    }

    if (!Object.keys(settings).length) {
      return;
    }
    if (
      newProvider === undefined &&
      newBaseUrl === '' &&
      newApiKey === '' &&
      newModelName === ''
    ) {
      return;
    }

    const timer = setTimeout(async () => {
      let changed = false;
      const nextSettings = { ...settings };

      const nextProvider = newProvider === '' ? undefined : newProvider;
      if (nextProvider !== settings.vlmProvider) {
        nextSettings.vlmProvider = nextProvider;
        changed = true;
      }

      if (newProvider === VLMProviderV2.gemini_vertex) {
        const isProjectIdValid = await form.trigger('vertexProjectId');
        if (
          isProjectIdValid &&
          newVertexProjectId !== undefined &&
          newVertexProjectId !== settings.vertexProjectId
        ) {
          nextSettings.vertexProjectId = newVertexProjectId;
          changed = true;
        }

        const isLocationValid = await form.trigger('vertexLocation');
        if (
          isLocationValid &&
          newVertexLocation !== undefined &&
          newVertexLocation !== settings.vertexLocation
        ) {
          nextSettings.vertexLocation = newVertexLocation;
          changed = true;
        }

        const isModelNameValid = await form.trigger('vertexModelName');
        if (
          isModelNameValid &&
          newVertexModelName !== undefined &&
          newVertexModelName !== settings.vertexModelName
        ) {
          nextSettings.vertexModelName = newVertexModelName;
          changed = true;
        }

        const isChatModelNameValid = await form.trigger('vertexChatModelName');
        if (
          isChatModelNameValid &&
          newVertexChatModelName !== undefined &&
          newVertexChatModelName !== settings.vertexChatModelName
        ) {
          nextSettings.vertexChatModelName = newVertexChatModelName;
          changed = true;
        }

        const isGoogleApiSourceValid = await form.trigger('googleApiSource');
        if (
          isGoogleApiSourceValid &&
          newGoogleApiSource !== undefined &&
          newGoogleApiSource !== settings.googleApiSource
        ) {
          nextSettings.googleApiSource = newGoogleApiSource;
          changed = true;
        }

        const isSAValid = await form.trigger('vertexServiceAccountPath');
        if (
          isSAValid &&
          newVertexServiceAccountPath !== undefined &&
          newVertexServiceAccountPath !== settings.vertexServiceAccountPath
        ) {
          nextSettings.vertexServiceAccountPath = newVertexServiceAccountPath;
          changed = true;
        }
      } else {
        const isUrlValid = await form.trigger('vlmBaseUrl');
        if (
          isUrlValid &&
          newBaseUrl !== undefined &&
          newBaseUrl !== settings.vlmBaseUrl
        ) {
          nextSettings.vlmBaseUrl = newBaseUrl;
          changed = true;
        }

        const isKeyValid = await form.trigger('vlmApiKey');
        if (
          isKeyValid &&
          newApiKey !== undefined &&
          newApiKey !== settings.vlmApiKey
        ) {
          nextSettings.vlmApiKey = newApiKey;
          changed = true;
        }

        const isNameValid = await form.trigger('vlmModelName');
        if (
          isNameValid &&
          newModelName !== undefined &&
          newModelName !== settings.vlmModelName
        ) {
          nextSettings.vlmModelName = newModelName;
          changed = true;
        }

        const isResponsesApiValid = await form.trigger('useResponsesApi');
        if (
          isResponsesApiValid &&
          newUseResponsesApi !== undefined &&
          newUseResponsesApi !== settings.useResponsesApi
        ) {
          nextSettings.useResponsesApi = newUseResponsesApi;
          changed = true;
        }
      }

      if (changed) {
        updateSetting(nextSettings);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [
    autoSave,
    newProvider,
    newBaseUrl,
    newApiKey,
    newModelName,
    newUseResponsesApi,
    newVertexProjectId,
    newVertexLocation,
    newVertexModelName,
    newVertexServiceAccountPath,
    settings,
    updateSetting,
    form,
    isRemoteAutoUpdatedPreset,
  ]);

  const handlePresetModal = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    setPresetModalOpen(true);
  };

  const handleUpdatePreset = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      await updatePresetFromRemote();
    } catch (error) {
      toast.error('Failed to update preset', {
        description:
          error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  };

  const handleResetPreset = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    await window.electron.setting.resetPreset();
    toast.success('Reset to manual mode successfully', {
      duration: 1500,
    });
  };

  const handleResponseApiChange = async (checked: boolean) => {
    if (checked) {
      if (responseApiSupported === null) {
        setIsCheckingResponseApi(true);
        const modelConfig = {
          baseUrl: newBaseUrl || '',
          // secretlint-disable-next-line
          apiKey: newApiKey || '',
          modelName: newModelName || '',
        };

        if (
          !modelConfig.baseUrl ||
          !modelConfig.apiKey ||
          !modelConfig.modelName
        ) {
          toast.error(
            'Please fill in all required fields before enabling Response API',
          );
          setIsCheckingResponseApi(false);
          return;
        }

        const isSupported = await api.checkVLMResponseApiSupport(modelConfig);
        setResponseApiSupported(isSupported);
        setIsCheckingResponseApi(false);

        if (!isSupported) {
          return;
        }
      }

      if (responseApiSupported) {
        form.setValue('useResponsesApi', true);
      }
    } else {
      form.setValue('useResponsesApi', false);
    }
  };

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    console.log('onSubmit', values);
    const apiValues = {
      ...values,
      vlmProvider: values.vlmProvider === '' ? undefined : values.vlmProvider,
    };
    await updateSetting({ ...settings, ...apiValues });
    toast.success('Settings saved successfully');
  };

  useImperativeHandle(ref, () => ({
    submit: async () => {
      return new Promise<z.infer<typeof formSchema>>((resolve, reject) => {
        form.handleSubmit(
          async (values) => {
            try {
              await onSubmit(values);
              resolve(values);
            } catch (error) {
              reject(error);
            }
          },
          (errors) => {
            reject(errors);
          },
        )();
      });
    },
  }));

  const switchDisabled =
    isRemoteAutoUpdatedPreset ||
    responseApiSupported === false ||
    isCheckingResponseApi;

  return (
    <>
      <Form {...form}>
        <form className={cn('space-y-8 px-[1px]', className)}>
          {!isRemoteAutoUpdatedPreset && (
            <Button type="button" variant="outline" onClick={handlePresetModal}>
              Import Preset Config
            </Button>
          )}
          {isRemoteAutoUpdatedPreset && (
            <PresetBanner
              url={settings.presetSource?.url}
              date={settings.presetSource?.lastUpdated}
              handleUpdatePreset={handleUpdatePreset}
              handleResetPreset={handleResetPreset}
            />
          )}

          {/* VLM Provider */}
          <FormField
            control={form.control}
            name="vlmProvider"
            render={({ field }) => {
              return (
                <FormItem>
                  <FormLabel>VLM Provider</FormLabel>
                  <Select
                    disabled={isRemoteAutoUpdatedPreset}
                    onValueChange={field.onChange}
                    value={field.value}
                  >
                    <SelectTrigger className="w-full bg-white">
                      <SelectValue placeholder="Select VLM provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(VLMProviderV2).map((provider) => (
                        <SelectItem key={provider} value={provider}>
                          {provider}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              );
            }}
          />

          {newProvider === VLMProviderV2.gemini_vertex ? (
            <>
              {/* Vertex Project ID */}
              <FormField
                control={form.control}
                name="vertexProjectId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Google Cloud Project ID</FormLabel>
                    <FormControl>
                      <Input
                        className="bg-white"
                        placeholder="Enter Google Cloud Project ID"
                        {...field}
                        disabled={isRemoteAutoUpdatedPreset}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Vertex Location */}
              <FormField
                control={form.control}
                name="vertexLocation"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Google Cloud Location</FormLabel>
                    <FormControl>
                      <Input
                        className="bg-white"
                        placeholder="Enter Google Cloud Location (e.g. us-central1)"
                        {...field}
                        disabled={isRemoteAutoUpdatedPreset}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Vertex Model Name */}
              <FormField
                control={form.control}
                name="vertexModelName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vertex AI Model Name</FormLabel>
                    <Select
                      disabled={isRemoteAutoUpdatedPreset}
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <SelectTrigger className="w-full bg-white">
                        <SelectValue placeholder="Select Gemini model name" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="gemini-2.5-pro">
                          gemini-2.5-pro ★ (Most Capable · Recommended)
                        </SelectItem>
                        <SelectItem value="gemini-2.5-flash">
                          gemini-2.5-flash (Fast · Recommended)
                        </SelectItem>
                        <SelectItem value="gemini-2.5-flash-lite">
                          gemini-2.5-flash-lite (Fastest)
                        </SelectItem>
                        <SelectItem value="gemini-2.0-pro">
                          gemini-2.0-pro
                        </SelectItem>
                        <SelectItem value="gemini-2.0-flash">
                          gemini-2.0-flash
                        </SelectItem>
                        <SelectItem value="gemini-1.5-pro">
                          gemini-1.5-pro
                        </SelectItem>
                        <SelectItem value="gemini-1.5-flash">
                          gemini-1.5-flash (Stable)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Google API Source */}
              <FormField
                control={form.control}
                name="googleApiSource"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Google API Mode / Source</FormLabel>
                    <Select
                      disabled={isRemoteAutoUpdatedPreset}
                      onValueChange={field.onChange}
                      value={field.value || 'direct'}
                    >
                      <SelectTrigger className="w-full bg-white">
                        <SelectValue placeholder="Select API Source" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="direct">
                          Google Vertex AI Gemini (Direct API)
                        </SelectItem>
                        <SelectItem value="agent_builder">
                          Google Conversational AI (Agent Builder Chat)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Vertex Chat Model Name */}
              {form.watch('googleApiSource') !== 'agent_builder' && (
                <FormField
                  control={form.control}
                  name="vertexChatModelName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Voice Agent Model Name</FormLabel>
                      <Select
                        disabled={isRemoteAutoUpdatedPreset}
                        onValueChange={field.onChange}
                        value={field.value || 'gemini-2.5-flash'}
                      >
                        <SelectTrigger className="w-full bg-white">
                          <SelectValue placeholder="Select Gemini voice model" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="gemini-2.5-pro">
                            gemini-2.5-pro (Highly Intelligent · Recommended)
                          </SelectItem>
                          <SelectItem value="gemini-2.5-flash">
                            gemini-2.5-flash (Fast & Conversational ·
                            Recommended)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {/* Vertex Service Account Path */}
              <FormField
                control={form.control}
                name="vertexServiceAccountPath"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Service Account JSON Path (Optional)</FormLabel>
                    <FormControl>
                      <Input
                        className="bg-white"
                        placeholder="Enter absolute path or leave blank for auto-detect"
                        {...field}
                        disabled={isRemoteAutoUpdatedPreset}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          ) : (
            <>
              {/* VLM Base URL */}
              <FormField
                control={form.control}
                name="vlmBaseUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>VLM Base URL</FormLabel>
                    <FormControl>
                      <Input
                        className="bg-white"
                        placeholder="Enter VLM Base URL"
                        {...field}
                        disabled={isRemoteAutoUpdatedPreset}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* VLM API Key */}
              <FormField
                control={form.control}
                name="vlmApiKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>VLM API Key</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          type={showPassword ? 'text' : 'password'}
                          className="bg-white"
                          placeholder="Enter VLM API_Key"
                          {...field}
                          disabled={isRemoteAutoUpdatedPreset}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                          onClick={() => setShowPassword(!showPassword)}
                          disabled={isRemoteAutoUpdatedPreset}
                        >
                          {showPassword ? (
                            <Eye className="h-4 w-4 text-gray-500" />
                          ) : (
                            <EyeOff className="h-4 w-4 text-gray-500" />
                          )}
                        </Button>
                      </div>
                    </FormControl>
                  </FormItem>
                )}
              />

              {/* VLM Model Name */}
              <FormField
                control={form.control}
                name="vlmModelName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>VLM Model Name</FormLabel>
                    <FormControl>
                      <Input
                        className="bg-white"
                        placeholder="Enter VLM Model Name"
                        {...field}
                        disabled={isRemoteAutoUpdatedPreset}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </>
          )}

          {/* Model Availability Check */}
          <ModelAvailabilityCheck
            modelConfig={
              newProvider === VLMProviderV2.gemini_vertex
                ? {
                    baseUrl: '',
                    // secretlint-disable-next-line
                    apiKey: '',
                    modelName: newVertexModelName || '',
                    provider: newProvider,
                    vertexProjectId: newVertexProjectId,
                    vertexLocation: newVertexLocation,
                    vertexModelName: newVertexModelName,
                    vertexServiceAccountPath: newVertexServiceAccountPath,
                  }
                : {
                    baseUrl: newBaseUrl || '',
                    // secretlint-disable-next-line
                    apiKey: newApiKey || '',
                    modelName: newModelName || '',
                    provider: newProvider,
                  }
            }
            onResponseApiSupportChange={setResponseApiSupported}
          />

          {/* VLM Model Responses API */}
          {newProvider !== VLMProviderV2.gemini_vertex && (
            <FormField
              control={form.control}
              name="useResponsesApi"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Use Responses API</FormLabel>
                  <FormControl>
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={field.value}
                        disabled={switchDisabled}
                        onCheckedChange={handleResponseApiChange}
                        className={cn(switchDisabled && '!cursor-not-allowed')}
                      />
                      {responseApiSupported === false && (
                        <p className="text-sm text-red-500">
                          Response API is not supported by this model
                        </p>
                      )}
                      {isCheckingResponseApi && (
                        <p className="text-sm text-muted-foreground flex items-center">
                          <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                          Checking Response API support...
                        </p>
                      )}
                    </div>
                  </FormControl>
                </FormItem>
              )}
            />
          )}
        </form>
      </Form>

      <PresetImport
        isOpen={isPresetModalOpen}
        onClose={() => setPresetModalOpen(false)}
      />
    </>
  );
}

interface ModelAvailabilityCheckProps {
  modelConfig: {
    baseUrl: string;
    // secretlint-disable-next-line
    apiKey: string;
    modelName: string;
    provider?: string;
    vertexProjectId?: string;
    vertexLocation?: string;
    vertexModelName?: string;
    vertexServiceAccountPath?: string;
  };
  disabled?: boolean;
  className?: string;
  onResponseApiSupportChange?: (supported: boolean) => void;
}

type CheckStatus = 'idle' | 'checking' | 'success' | 'error';

interface CheckState {
  status: CheckStatus;
  message?: string;
  responseApiSupported?: boolean;
}

export function ModelAvailabilityCheck({
  modelConfig,
  disabled = false,
  className,
  onResponseApiSupportChange,
}: ModelAvailabilityCheckProps) {
  const [checkState, setCheckState] = useState<CheckState>({ status: 'idle' });

  const {
    baseUrl,
    apiKey,
    modelName,
    provider,
    vertexProjectId,
    vertexLocation,
  } = modelConfig;
  const isConfigValid =
    provider === VLMProviderV2.gemini_vertex
      ? !!(vertexProjectId && vertexLocation && modelName)
      : !!(baseUrl && apiKey && modelName);

  useEffect(() => {
    if (checkState.status === 'success' || checkState.status === 'error') {
      setTimeout(() => {
        const scrollContainer = document.querySelector(
          '[data-radix-scroll-area-viewport]',
        );
        if (scrollContainer) {
          scrollContainer.scrollTo({
            top: scrollContainer.scrollHeight,
            behavior: 'smooth',
          });
        }
      }, 200);
    }
  }, [checkState.status]);

  const handleCheckModel = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isConfigValid) {
      toast.error(
        'Please fill in all required fields before checking model availability',
      );
      return;
    }

    setCheckState({ status: 'checking' });

    try {
      if (provider === VLMProviderV2.gemini_vertex) {
        const isAvailable = await api.checkModelAvailability(modelConfig);
        onResponseApiSupportChange?.(false);
        if (isAvailable) {
          setCheckState({
            status: 'success',
            message: `Model "${modelName}" is available and Vertex AI Gemini client authenticated successfully!`,
            responseApiSupported: false,
          });
        } else {
          setCheckState({
            status: 'error',
            message: `Model "${modelName}" is not responding correctly. Check Project ID and region permissions.`,
          });
        }
      } else {
        const [isAvailable, responseApiSupported] = await Promise.all([
          api.checkModelAvailability(modelConfig),
          api.checkVLMResponseApiSupport(modelConfig),
        ]);

        onResponseApiSupportChange?.(responseApiSupported);

        if (isAvailable) {
          const successMessage = `Model "${modelName}" is available and working correctly${
            responseApiSupported
              ? '. Response API is supported.'
              : '. But Response API is not supported.'
          }`;
          setCheckState({
            status: 'success',
            message: successMessage,
            responseApiSupported,
          });
        } else {
          const errorMessage = `Model "${modelName}" is not responding correctly`;
          setCheckState({
            status: 'error',
            message: errorMessage,
            responseApiSupported,
          });
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      const fullErrorMessage = `Failed to connect to model: ${errorMessage}`;

      setCheckState({
        status: 'error',
        message: fullErrorMessage,
      });

      onResponseApiSupportChange?.(false);
    }
  };

  return (
    <div className={`space-y-4 ${className || ''}`}>
      <Button
        type="button"
        variant="outline"
        onClick={handleCheckModel}
        disabled={
          disabled || checkState.status === 'checking' || !isConfigValid
        }
        className="w-50"
      >
        {checkState.status === 'checking' ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Checking Model...
          </>
        ) : (
          'Check Model Availability'
        )}
      </Button>

      {checkState.status === 'success' && (
        <Alert className="border-green-200 bg-green-50">
          <CheckCircle className="h-4 w-4 !text-green-600" />
          <AlertDescription className="text-green-800">
            {checkState.message}
          </AlertDescription>
        </Alert>
      )}

      {checkState.status === 'error' && (
        <Alert className="border-red-200 bg-red-50">
          <XCircle className="h-4 w-4 !text-red-600" />
          <AlertDescription className="text-red-800">
            {checkState.message}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
